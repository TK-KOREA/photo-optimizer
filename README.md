# Photo Optimizer

2억 화소 사진(30~50MB)을 보관·공유용 **7MB 안팎(±3MB)**으로 줄이는 변환기. 웹 서비스와 PC 프로그램이 같은 코드를 씁니다.

## 동작 방식

1. EXIF 회전 반영 → 선형 광 공간에서 Lanczos3 축소 (기본: 2억 → 5천만 화소)
2. 목표 용량 하나(기본 7MB)에 ±3MB 오차를 허용하고, JPEG 품질 85~95 사이를 이진 탐색해 **상한(목표+3MB) 이하 최고 품질** 선택
3. 품질 85로도 상한을 넘으면 해상도를 한 단계씩 낮춤 (0.5 → 0.45 → … → 0.25배)
4. 4:4:4 크로마, mozjpeg 최적화, EXIF·ICC·XMP 보존, GPS는 기본 제거

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
python -m photo_optimizer.cli D:\사진 -o D:\사진_축소 --target 7
```

브라우저 전용 버전 (`photo_optimizer/docs`, 서버 없이 사진을 기기 안에서 변환):

https://tk-korea.github.io/photo-optimizer/

용도 프리셋으로 고른다: 원본 해상도(해상도 그대로 용량만 줄임) · 고화질 보관(5천만 화소, 4–10MB) · 카톡·메신저(긴 변 4000px, 4MB 이하) · 메일 첨부(긴 변 3000px, 2MB 이하) · 직접 설정(목표 용량 ±3MB). 이미 프리셋 안에 드는 JPEG는 다시 압축하지 않는다.

같은 libvips를 WebAssembly로 빌드한 [wasm-vips](https://github.com/kleisauke/wasm-vips)로 위와 같은 방식으로 변환합니다. `main`에 푸시하면 GitHub Actions가 Pages로 배포합니다. HEIC는 지원하지 않습니다. 로컬에서 확인하려면:

```bash
python -m http.server 8000 --directory photo_optimizer/docs
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
