# Photo Optimizer

2억 화소 사진(30~50MB)을 용도에 맞게 줄이는 변환기. 웹 서비스, PC 프로그램, 명령줄, 브라우저 전용 버전이 같은 프리셋을 씁니다.

## 용도 프리셋

| 프리셋 | 이름(`--preset`) | 결과 |
|---|---|---|
| 리마스터 | `remaster` | 1,600만 화소로 줄이며 밝기·대비·색 자동 보정 (그늘진 얼굴 밝히기), 8MB 이하 |
| 원본 해상도 | `original` | 해상도 그대로 다시 저장해 용량만 줄임 (회전은 EXIF 방향값으로 유지) |
| 고화질 보관 (기본) | `archive` | 약 5천만 화소, 4–10MB |
| 카톡·메신저 | `messenger` | 긴 변 4000px, 4MB 이하 |
| 메일 첨부 | `mail` | 긴 변 3000px, 2MB 이하 |
| 직접 설정 | `--target N` | 목표 용량 N MB(±3MB) |

이미 용량 상한 안의 JPEG는 다시 압축하지 않고(위치 정보 지우기를 켰으면 그것만 무손실로 지움), 결과가 원본 JPEG보다 크면 원본을 그대로 씁니다. 리마스터는 색을 바꾸므로 이 두 경우에도 변환합니다.

촬영 위치는 기본으로 유지하고(변환 전에 읽어 두었다가 결과에 다시 넣음), 갤럭시·픽셀의 HDR 사진(Ultra HDR 게인맵)은 게인맵도 결과 크기에 맞춰 줄여 함께 저장합니다.

리마스터의 자동 보정은 갤럭시 S24 울트라 "사진 리마스터"의 2억 화소 결과를 재서 맞춘 레벨·채도 보정에, 역광 사진의 얼굴을 밝히는 부분 밝힘을 더한 것입니다. 디테일을 새로 그리지 않습니다.

## 동작 방식 (고화질 보관·직접 설정)

1. EXIF 회전 반영 → 선형 광 공간에서 Lanczos3 축소 (기본: 2억 → 5천만 화소)
2. 목표 용량 하나(기본 7MB)에 ±3MB 오차를 허용하고, JPEG 품질 85~95 사이를 이진 탐색해 **상한(목표+3MB) 이하 최고 품질** 선택
3. 품질 85로도 상한을 넘으면 해상도를 한 단계씩 낮춤 (0.5 → 0.45 → … → 0.25배)
4. 4:4:4 크로마(리마스터는 4:2:0), mozjpeg 최적화, EXIF·ICC·XMP 보존, 위치 정보는 기본 유지(옵션으로 제거)

## 실행

```bash
pip install -r requirements.txt
```

웹 서비스:

```bash
python -m uvicorn photo_optimizer.app:app --host 0.0.0.0 --port 8765
```

PC 프로그램 (내 컴퓨터 안에서만 동작, 사진이 외부로 나가지 않음):

```bash
python -m photo_optimizer.desktop
```

폴더 일괄 변환:

```bash
python -m photo_optimizer.cli D:\사진 -o D:\사진_축소 --preset messenger
```

브라우저 전용 버전 (`photo_optimizer/docs`, 서버 없이 사진을 기기 안에서 변환):

https://tk-korea.github.io/photo-optimizer/

같은 libvips를 WebAssembly로 빌드한 [wasm-vips](https://github.com/kleisauke/wasm-vips)로 위와 같은 방식으로 변환합니다. `main`에 푸시하면 GitHub Actions가 Pages로 배포합니다. HEIC는 지원하지 않습니다. 로컬에서 확인하려면:

```bash
python -m http.server 8000 --directory photo_optimizer/docs
```

안드로이드 앱 (`android`, 브라우저판 변환기를 앱 안에 넣은 것):

안드로이드는 위치 읽기 권한이 없는 앱(브라우저 포함)에 사진을 넘길 때 촬영 위치를 0으로 지웁니다. 앱은 그 권한(`ACCESS_MEDIA_LOCATION`)을 받아 원본 위치를 지킵니다. 결과는 사진첩의 `Pictures/photo-optimizer`에 저장됩니다.

```bash
cd android
gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 환경 변수 (웹 서비스)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PHOTO_OPTIMIZER_MAX_JOBS` | 2 | 동시 변환 수. 1건당 약 0.9GB 메모리 |
| `PHOTO_OPTIMIZER_MAX_UPLOAD_MB` | 120 | 업로드 최대 크기 |

## PC 프로그램 배포 (exe)

```bash
pip install pyinstaller
pyinstaller --name PhotoOptimizer --windowed --add-data "photo_optimizer/static;photo_optimizer/static" --collect-all pyvips --collect-all _libvips photo_optimizer/desktop.py
```
