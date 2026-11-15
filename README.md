# 동대문구 임차인 계약 전 공공자료 확인 안내 웹사이트

이 프로젝트는 **Netlify 정적 호스팅 + Netlify Functions(서버리스 백엔드)** 구조로 구성되어 있습니다.
발급받은 공공데이터 API 키가 외부 브라우저에 노출되지 않도록 서버리스 함수(`netlify/functions/fetch-public-data.js`)에서 키를 처리합니다.

## 폴더 구조
```text
dongdaemun-tenant-site/
├── netlify.toml                         # Netlify 빌드 및 함수 경로 설정
├── package.json                         # XML 파서 등 백엔드 의존성
├── README.md                            # 배포 및 환경변수 설정 안내
├── netlify/
│   └── functions/
│       └── fetch-public-data.js         # 주소변환 · 건축HUB · 실거래가 · HUG API 연동 백엔드
└── public/
    └── index.html                       # 프론트엔드 화면 (시연용 모드 & 실제 API 모드 지원)
```

## Netlify 배포 및 API 키 연결 방법

1. **프로젝트 업로드:**
   - GitHub 저장소에 이 폴더 전체를 올린 뒤 Netlify에서 **"Import an existing project"**로 연결합니다. (또는 Netlify CLI `netlify deploy --prod` 사용)
2. **환경변수(Environment Variables) 등록:**
   - Netlify 대시보드 → **Site configuration** → **Environment variables** 메뉴에서 아래 3개의 키를 등록합니다.
   - `JUSO_API_KEY`: 행정안전부 주소기반산업지원서비스 승인키
   - `DATA_GO_KR_KEY`: 공공데이터포털 일반 인증키 (건축HUB + 국토부 실거래가 API 활용신청 완료 키)
   - `HUG_API_KEY`: HOUSTA(HUG) 상습 채무불이행자 명단공개 API_KEY
3. **실제 API 모드로 전환:**
   - 사이트 배포 후 상단 우측의 **`실제 API 모드: OFF`** 버튼을 클릭해 **`ON`**으로 전환하면 실제 공공데이터를 실시간 조회합니다.
