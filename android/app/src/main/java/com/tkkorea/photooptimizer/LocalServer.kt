package com.tkkorea.photooptimizer

import android.content.res.AssetManager
import android.util.Log
import java.io.BufferedOutputStream
import java.io.File
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors

/**
 * 변환기 파일을 이 기기 안에서만(127.0.0.1) 내주는 아주 작은 웹 서버.
 *
 * WebView의 shouldInterceptRequest는 워커가 다시 띄우는 워커(wasm-vips의 스레드)의 요청을
 * 가로채지 못해, 엔진이 스레드를 띄우다 멈춘다. 진짜 HTTP로 내주면 모든 요청이 같은 길을 탄다.
 * 127.0.0.1은 https가 아니어도 안전한 출처로 취급되어 교차 출처 격리를 쓸 수 있다.
 *
 * 고른 사진(cache/picked)은 실행할 때마다 바뀌는 비밀 경로로만 내준다. 같은 기기의 다른 앱이
 * 이 포트에 접속해도 사진을 볼 수 없게 하기 위해서다.
 */
class LocalServer(
    private val assets: AssetManager,
    private val pickedDir: File,
    private val secret: String,
) {
    private val pool = Executors.newCachedThreadPool()
    private var socket: ServerSocket? = null
    val port: Int get() = socket?.localPort ?: 0
    val origin: String get() = "http://127.0.0.1:$port"

    /** 고른 사진의 주소 (cache/picked 기준 상대 경로) */
    fun pickedUrl(relative: String) = "$origin/__picked/$secret/$relative"

    fun start() {
        // 출처(포트)가 바뀌면 브라우저 저장소(설정 기억 등)가 초기화되므로 고정 포트를 먼저 시도한다
        // 앱을 바로 다시 열면 직전 소켓이 아직 정리 중(TIME_WAIT)이라 같은 포트를 못 잡을 수 있어 재사용을 켠다
        val bind = { port: Int ->
            ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 50) }
        }
        val s = runCatching { bind(PORT) }.getOrElse { bind(0) }
        socket = s
        Thread({
            while (!s.isClosed) {
                val c = runCatching { s.accept() }.getOrNull() ?: break
                pool.execute { runCatching { handle(c) }.onFailure { Log.d(TAG, "request failed: $it") } }
            }
        }, "LocalServer").apply { isDaemon = true }.start()
        Log.i(TAG, "serving on $origin")
    }

    fun stop() {
        runCatching { socket?.close() }
        pool.shutdownNow()
    }

    private fun handle(c: Socket) = c.use {
        c.soTimeout = 30_000
        val input = c.getInputStream()
        val requestLine = readLine(input) ?: return
        while (true) { val h = readLine(input) ?: break; if (h.isEmpty()) break }  // 헤더는 쓰지 않는다
        val parts = requestLine.split(" ")
        val method = parts.getOrNull(0) ?: return
        val rawPath = parts.getOrNull(1)?.substringBefore('?')?.substringBefore('#') ?: return
        val path = URLDecoder.decode(rawPath, "UTF-8").removePrefix("/").ifEmpty { "index.html" }

        val body: ByteArray? = if (method == "GET" || method == "HEAD") load(path) else null
        val out = BufferedOutputStream(c.getOutputStream(), 64 * 1024)
        val status = if (body != null) "200 OK" else "404 Not Found"
        val bytes = body ?: "not found".toByteArray()
        if (BuildConfig.DEBUG) Log.d(TAG, "serve $path -> ${status.substringBefore(' ')}")
        val head = buildString {
            append("HTTP/1.1 $status\r\n")
            append("Content-Type: ${if (body != null) mimeOf(path) else "text/plain"}\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("Cross-Origin-Opener-Policy: same-origin\r\n")
            append("Cross-Origin-Embedder-Policy: require-corp\r\n")
            append("Cross-Origin-Resource-Policy: same-origin\r\n")
            append("Document-Isolation-Policy: isolate-and-require-corp\r\n")
            append("Cache-Control: no-cache\r\n")
            append("Connection: close\r\n\r\n")
        }
        out.write(head.toByteArray())
        if (method != "HEAD") out.write(bytes)
        out.flush()
    }

    private fun load(path: String): ByteArray? = runCatching {
        if (path.startsWith("__picked/")) {
            val rest = path.removePrefix("__picked/")
            if (rest.substringBefore('/') != secret) return null
            val root = pickedDir.canonicalFile
            val f = File(root, rest.substringAfter('/')).canonicalFile
            if (f.path.startsWith(root.path + File.separator) && f.isFile) f.readBytes() else null
        } else if (path.split('/').any { it == ".." }) {
            null
        } else {
            assets.open(path).use { it.readBytes() }
        }
    }.getOrNull()

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(b.toChar())
            if (sb.length > 8192) return null
        }
    }

    private fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "wasm" -> "application/wasm"
        "json", "webmanifest" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    companion object {
        private const val TAG = "PhotoOptimizer"
        private const val PORT = 47361
    }
}
