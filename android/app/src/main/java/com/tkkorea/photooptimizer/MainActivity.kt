package com.tkkorea.photooptimizer

import android.Manifest
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executors

/**
 * 브라우저판 변환기(photo_optimizer/docs)를 앱 안의 WebView로 띄운다.
 *
 * 브라우저(PWA)는 안드로이드의 "사진 위치 읽기" 권한(ACCESS_MEDIA_LOCATION)을 받을 수 없어서,
 * 사진을 고르면 안드로이드가 촬영 위치를 0으로 지운 채 넘겨준다. 이 앱은 그 권한을 받고
 * MediaStore.setRequireOriginal로 원본을 열어 위치가 그대로 담긴 사진을 변환기에 넘긴다.
 *
 * 변환기는 SharedArrayBuffer(wasm 스레드)를 쓰므로 페이지가 교차 출처 격리되어야 한다.
 * 그래서 파일을 앱 안의 https 주소로 직접 내주며 COOP/COEP 헤더를 붙인다.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var server: LocalServer
    private val io = Executors.newSingleThreadExecutor()
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pageReady = false
    private val pendingShared = mutableListOf<File>()

    private val pickDocs = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { deliverPicked(it) }
    private var afterPermission: (() -> Unit)? = null
    private val askLocation = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        afterPermission?.invoke(); afterPermission = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        server = LocalServer(assets, File(cacheDir, "picked"), java.util.UUID.randomUUID().toString()).apply { start() }
        allowCrossOriginIsolation(server.origin)
        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = true
        }
        web.addJavascriptInterface(Bridge(), "PhotoOptimizerApp")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, PAGE_SHIM, setOf(server.origin))
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "127.0.0.1") return false
                // 오픈소스 고지 같은 바깥 링크는 브라우저로 연다
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                pageReady = false
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) view.evaluateJavascript(PAGE_SHIM, null)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                pageReady = true
                flushShared()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                // 사진 선택기(PickVisualMedia)는 안드로이드 17에서 앱에 위치 권한이 있어도 위치를 0으로 지워
                // 넘겨준다(사용자가 선택기 안에서 위치 공유를 따로 허용해야 한다). 문서 선택기로 연 사진은
                // 위치 권한이 있는 앱에 원본 그대로 열리므로, 두 버튼 모두 문서 선택기를 쓴다.
                withLocationPermission { pickDocs.launch(arrayOf("image/*")) }
                return true
            }
        }

        web.loadUrl("${server.origin}/index.html")
        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    override fun onDestroy() {
        web.destroy()
        server.stop()
        io.shutdown()
        super.onDestroy()
    }

    /**
     * WebView는 렌더러 프로세스 격리가 없어 기본으로는 교차 출처 격리(SharedArrayBuffer)를 켜지 않는다.
     * 앱 안의 변환기 주소 하나만 허용한다. 페이지는 Document-Isolation-Policy 헤더로 함께 옵트인한다.
     */
    private fun allowCrossOriginIsolation(origin: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.CROSS_ORIGIN_ISOLATED_ALLOWLIST)) {
            Log.w(TAG, "이 WebView는 교차 출처 격리 허용 목록을 지원하지 않습니다")
            return
        }
        val profile = ProfileStore.getInstance().getProfile(Profile.DEFAULT_PROFILE_NAME) ?: return
        profile.setCrossOriginIsolatedAllowlist(setOf(origin))
        Log.i(TAG, "cross-origin isolation allowlist: ${profile.crossOriginIsolatedAllowlist}")
    }

    // ---------- 위치 권한 ----------

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun withLocationPermission(then: () -> Unit) {
        if (hasLocationPermission()) return then()
        afterPermission = then
        askLocation.launch(Manifest.permission.ACCESS_MEDIA_LOCATION)
    }

    // ---------- 원본 열기 ----------

    /** 위치가 지워지지 않은 원본을 연다. 안 되면 받은 그대로 연다. */
    private fun openOriginal(uri: Uri): InputStream? {
        val candidates = buildList {
            if (hasLocationPermission()) {
                runCatching { MediaStore.getMediaUri(this@MainActivity, uri) }.getOrNull()
                    ?.let { add("mediaUri+original" to MediaStore.setRequireOriginal(it)) }
                runCatching { MediaStore.setRequireOriginal(uri) }.getOrNull()?.let { add("original" to it) }
            }
            add("as-is" to uri)
        }
        for ((how, u) in candidates) {
            val stream = runCatching { contentResolver.openInputStream(u) }
                .onFailure { Log.d(TAG, "open $how failed: $it") }.getOrNull()
            if (stream != null) {
                Log.i(TAG, "opened $uri via $how")
                return stream
            }
        }
        return null
    }

    private fun displayName(uri: Uri): String {
        val name = runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull()
        return (name ?: "photo.jpg").replace(Regex("[\\\\/:*?\"<>|]"), "_")
    }

    /** 고른 사진들을 원본 그대로 앱 캐시에 복사한다 (WebView가 읽을 수 있게). */
    private fun copyOriginals(uris: List<Uri>): List<File> {
        val dir = File(cacheDir, "picked").apply { deleteRecursively(); mkdirs() }
        return uris.mapIndexedNotNull { i, uri ->
            val stream = openOriginal(uri) ?: return@mapIndexedNotNull null
            val sub = File(dir, i.toString()).apply { mkdirs() }  // 같은 이름 사진이 겹치지 않게
            File(sub, displayName(uri)).also { f -> stream.use { s -> f.outputStream().use { s.copyTo(it) } } }
        }
    }

    private fun deliverPicked(uris: List<Uri>) {
        val callback = fileCallback ?: return
        fileCallback = null
        if (uris.isEmpty()) return callback.onReceiveValue(null)
        io.execute {
            val files = copyOriginals(uris)
            val out = files.map { FileProvider.getUriForFile(this, "$packageName.files", it) }.toTypedArray()
            runOnUiThread { callback.onReceiveValue(out) }
        }
    }

    // ---------- 공유로 받기 ----------

    private fun handleShareIntent(intent: Intent?) {
        val uris: List<Uri> = when (intent?.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.parcelable(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.parcelableList(Intent.EXTRA_STREAM)
            else -> emptyList()
        }
        if (uris.isEmpty()) return
        withLocationPermission {
            io.execute {
                val files = copyOriginals(uris)
                runOnUiThread {
                    pendingShared += files
                    flushShared()
                }
            }
        }
    }

    /** 공유받은 사진을 페이지의 사진 입력란에 넣어 변환을 시작한다. */
    private fun flushShared() {
        if (!pageReady || pendingShared.isEmpty()) return
        val list = JSONArray()
        val root = File(cacheDir, "picked")
        for (f in pendingShared) list.put(JSONArray().put(server.pickedUrl(f.relativeTo(root).invariantSeparatorsPath)).put(f.name))
        pendingShared.clear()
        web.evaluateJavascript(
            """
            (async () => {
              for (let i = 0; i < 100 && !window.crossOriginIsolated; i++) await new Promise(r => setTimeout(r, 100));
              await new Promise(r => setTimeout(r, 300));
              const dt = new DataTransfer();
              for (const [url, name] of $list) {
                const b = await (await fetch(url)).blob();
                dt.items.add(new File([b], name, { type: b.type || "image/jpeg" }));
              }
              const pick = document.getElementById("pick");
              pick.files = dt.files;
              pick.dispatchEvent(new Event("change"));
            })();
            """.trimIndent(), null,
        )
    }

    // ---------- 페이지에서 부르는 기능: 저장·보내기 ----------

    private inner class Bridge {
        /** 결과를 사진첩(Pictures/photo-optimizer)에, ZIP은 다운로드 폴더(Download/photo-optimizer)에 저장한다. 바이트는 손대지 않는다. */
        @JavascriptInterface
        fun save(base64: String, name: String, mime: String) {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val ok = runCatching { saveToMediaStore(bytes, name, mime) }
                .onFailure { Log.e(TAG, "save failed", it) }.isSuccess
            if (BuildConfig.DEBUG && android.os.Build.VERSION.SDK_INT >= 34 && mime == "image/jpeg") {
                // 안드로이드가 이 파일을 HDR(게인맵 있는 Ultra HDR)로 읽는지 확인한다
                val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = 8 }
                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
                Log.i(TAG, "saved $name ${bytes.size}B ${bmp?.width}x${bmp?.height} hasGainmap=${bmp?.hasGainmap()}" +
                    (bmp?.gainmap?.let { " gainmap=${it.gainmapContents.width}x${it.gainmapContents.height} max=${it.ratioMax.joinToString()}" } ?: ""))
            }
            runOnUiThread {
                Toast.makeText(this@MainActivity, if (ok) "저장했어요" else "저장하지 못했어요", Toast.LENGTH_SHORT).show()
            }
        }

        /** 카카오톡·메일 등 다른 앱으로 보내기. files = [[base64, name, mime], ...] */
        @JavascriptInterface
        fun share(json: String) {
            val arr = JSONArray(json)
            val dir = File(cacheDir, "out").apply { deleteRecursively(); mkdirs() }
            val uris = ArrayList<Uri>()
            var mime = "image/jpeg"
            for (i in 0 until arr.length()) {
                val item = arr.getJSONArray(i)
                mime = item.getString(2)
                val sub = File(dir, i.toString()).apply { mkdirs() }
                val f = File(sub, item.getString(1))
                f.writeBytes(Base64.decode(item.getString(0), Base64.DEFAULT))
                uris += FileProvider.getUriForFile(this@MainActivity, "$packageName.files", f)
            }
            val send = if (uris.size == 1) {
                Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
            } else {
                Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            }
            send.setType(mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            runOnUiThread { startActivity(Intent.createChooser(send, null)) }
        }
    }

    private fun saveToMediaStore(bytes: ByteArray, name: String, mime: String) {
        val image = mime.startsWith("image/")
        val collection = if (image) MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH,
                (if (image) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS) + "/photo-optimizer")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(collection, values) ?: error("insert failed")
        try {
            contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            contentResolver.delete(uri, null, null)
            throw e
        }
    }

    companion object {
        private const val TAG = "PhotoOptimizer"

        /**
         * 페이지가 열리기 전에 넣는 코드.
         * - 저장: <a download>로 받는 blob을 앱으로 넘겨 사진첩에 저장한다 (WebView는 blob 다운로드를 못 한다)
         * - 보내기: navigator.share({ files })를 앱의 공유 창으로 잇는다
         */
        private val PAGE_SHIM = """
            (() => {
              if (window.__photoOptimizerApp) return;
              window.__photoOptimizerApp = true;
              const app = window.PhotoOptimizerApp;
              const b64 = blob => new Promise((ok, fail) => {
                const r = new FileReader();
                r.onload = () => ok(String(r.result).slice(String(r.result).indexOf(",") + 1));
                r.onerror = () => fail(r.error);
                r.readAsDataURL(blob);
              });
              document.addEventListener("click", async e => {
                const a = e.target.closest && e.target.closest("a[download]");
                if (!a || !a.href.startsWith("blob:")) return;
                e.preventDefault();
                const blob = await (await fetch(a.href)).blob();
                app.save(await b64(blob), a.download || "photo.jpg", blob.type || "image/jpeg");
              }, true);
              navigator.canShare = data => !!(data && data.files && data.files.length);
              navigator.share = async data => {
                const files = await Promise.all([...data.files].map(async f => [await b64(f), f.name, f.type || "image/jpeg"]));
                app.share(JSON.stringify(files));
              };
            })();
        """.trimIndent()
    }
}

@Suppress("DEPRECATION")
private fun Intent.parcelable(key: String): Uri? =
    if (android.os.Build.VERSION.SDK_INT >= 33) getParcelableExtra(key, Uri::class.java) else getParcelableExtra(key)

@Suppress("DEPRECATION")
private fun Intent.parcelableList(key: String): List<Uri> =
    (if (android.os.Build.VERSION.SDK_INT >= 33) getParcelableArrayListExtra(key, Uri::class.java)
    else getParcelableArrayListExtra(key)) ?: emptyList()
