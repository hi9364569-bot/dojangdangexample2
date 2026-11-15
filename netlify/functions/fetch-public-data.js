const { XMLParser } = require("fast-xml-parser");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false // Keep codes like '0012' as strings
});

// Helper: Fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

// 1. 주소 변환 (행정안전부 주소기반산업지원서비스)
async function lookupAddress(roadAddr, jusoKey) {
  if (!jusoKey) return { status: "NO_KEY", error: "JUSO_API_KEY가 설정되지 않았습니다." };
  const url = `https://business.juso.go.kr/addrlink/addrLinkApi.do?confmKey=${encodeURIComponent(jusoKey)}&currentPage=1&countPerPage=5&keyword=${encodeURIComponent(roadAddr)}&resultType=json`;
  const res = await fetchWithTimeout(url);
  const data = await res.json();
  const common = data?.results?.common;
  const jusoList = data?.results?.juso;

  if (common?.errorCode !== "0" || !jusoList || jusoList.length === 0) {
    return { status: "NOT_FOUND", error: common?.errorMessage || "일치하는 주소를 찾지 못했습니다." };
  }

  const item = jusoList[0];
  // admCd: 10자리 법정동코드 (앞 5자리 sigunguCd, 뒤 5자리 bjdongCd)
  const admCd = item.admCd || "";
  const sigunguCd = admCd.substring(0, 5);
  const bjdongCd = admCd.substring(5, 10);
  const bun = String(item.lnbrMnnm || "0").padStart(4, "0");
  const ji = String(item.lnbrSlno || "0").padStart(4, "0");
  const platGbCd = item.mtYn === "1" ? "1" : "0"; // 0:대지, 1:산

  return {
    status: "OK",
    roadAddr: item.roadAddr,
    jibunAddr: item.jibunAddr,
    bdNm: item.bdNm || "",
    sigunguCd,
    bjdongCd,
    platGbCd,
    bun,
    ji
  };
}

// 2. 건축물대장 표제부 조회 (국토교통부 건축HUB)
async function fetchBuildingInfo(addrInfo, dataGoKrKey) {
  if (!dataGoKrKey) return { status: "NO_KEY", error: "DATA_GO_KR_KEY가 설정되지 않았습니다." };
  const baseUrl = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo";
  const params = new URLSearchParams({
    serviceKey: dataGoKrKey,
    sigunguCd: addrInfo.sigunguCd,
    bjdongCd: addrInfo.bjdongCd,
    platGbCd: addrInfo.platGbCd,
    bun: addrInfo.bun,
    ji: addrInfo.ji,
    numOfRows: "10",
    pageNo: "1",
    _type: "json"
  });

  const res = await fetchWithTimeout(`${baseUrl}?${params.toString()}`);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = xmlParser.parse(text);
  }

  const header = parsed?.response?.header;
  if (header && header.resultCode !== "00") {
    return { status: "API_ERROR", error: `${header.resultCode}: ${header.resultMsg}` };
  }

  const rawItems = parsed?.response?.body?.items?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  if (items.length === 0) {
    return { status: "EMPTY", error: "해당 지번의 건축물대장 표제부 자료가 조회되지 않았습니다." };
  }

  const target = items[0];
  return {
    status: "OK",
    buildingCount: items.length,
    platPlc: target.platPlc || addrInfo.jibunAddr,
    newPlatPlc: target.newPlatPlc || addrInfo.roadAddr,
    bldNm: target.bldNm || addrInfo.bdNm || "(건물명 미등재)",
    mainPurpsCdNm: target.mainPurpsCdNm || "미상",
    etcPurps: target.etcPurps || "",
    totArea: target.totArea || "",
    grndFlrCnt: target.grndFlrCnt || "",
    ugrndFlrCnt: target.ugrndFlrCnt || "",
    useAprDay: target.useAprDay || "",
    crtnDay: target.crtnDay || "" // 원자료 기준일
  };
}

// 3. 주변 매매 실거래가 조회 (주택 유형별 API 분기)
async function fetchRealEstateTrades(sigunguCd, houseType, targetArea, depositManwon, dataGoKrKey) {
  if (!dataGoKrKey) return { status: "NO_KEY", error: "DATA_GO_KR_KEY가 설정되지 않았습니다." };

  // 단독/다가구는 호실 보증금과 건물 전체 매매가 비교 불가 (조사 문서 원칙 반영)
  if (houseType === "detached") {
    return {
      status: "EXCLUDED_TYPE",
      reason: "단독·다가구 주택은 개별 방(호실) 보증금을 건물 전체 매매가격과 비교할 수 없어 비율 산정에서 제외됩니다."
    };
  }

  const endpointMap = {
    multiplex: "https://apis.data.go.kr/1613000/RTMSDataSvcRHTrade2/getRTMSDataSvcRHTrade2",
    apartment: "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev"
  };
  const endpoint = endpointMap[houseType];
  if (!endpoint) {
    return { status: "INVALID_TYPE", error: "지원하지 않는 주택 유형입니다." };
  }

  // 최근 6개월 계약연월(YYYYMM) 생성
  const now = new Date();
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.push(ym);
  }

  const allTrades = [];
  for (const ym of months) {
    const params = new URLSearchParams({
      serviceKey: dataGoKrKey,
      LAWD_CD: sigunguCd,
      DEAL_YMD: ym,
      numOfRows: "100",
      pageNo: "1"
    });

    const res = await fetchWithTimeout(`${endpoint}?${params.toString()}`);
    const xmlText = await res.text();
    const parsed = xmlParser.parse(xmlText);
    const header = parsed?.response?.header;
    if (header && header.resultCode !== "00" && header.resultCode !== "000") {
      return { status: "API_ERROR", error: `${header.resultCode}: ${header.resultMsg}` };
    }

    const rawItems = parsed?.response?.body?.items?.item;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

    for (const item of items) {
      // 해제 여부 확인 (cdealType 필드가 비어있지 않으면 해제 거래로 제외)
      if (item.cdealType && String(item.cdealType).trim() !== "") continue;

      const area = parseFloat(item.excluUseAr || item["전용면적"] || "0");
      const rawAmount = String(item.dealAmount || item["거래금액"] || "0").replace(/,/g, "").trim();
      const amountManwon = parseInt(rawAmount, 10);

      if (!amountManwon || isNaN(amountManwon)) continue;

      // 유사 전용면적 필터링 (사용자 입력 면적이 있을 경우 ±15% 이내)
      if (targetArea && targetArea > 0) {
        const diffRatio = Math.abs(area - targetArea) / targetArea;
        if (diffRatio > 0.15) continue;
      }

      allTrades.push({
        ym,
        area,
        amountManwon,
        dong: item.umdNm || item["법정동"] || "",
        name: item.mhouseNm || item.aptNm || item["연립다세대"] || item["아파트"] || ""
      });
    }
  }

  // 표본 부족 기준 (예: 최소 3건 미만 시 산정 보류)
  if (allTrades.length < 3) {
    return {
      status: "INSUFFICIENT_SAMPLE",
      sampleCount: allTrades.length,
      periodMonths: 6,
      reason: `최근 6개월 내 유사 면적 매매 표본이 ${allTrades.length}건으로 부족하여 비율을 산정하지 않았습니다.`
    };
  }

  const sortedPrices = allTrades.map(t => t.amountManwon).sort((a, b) => a - b);
  const mid = Math.floor(sortedPrices.length / 2);
  const medianManwon = sortedPrices.length % 2 !== 0
    ? sortedPrices[mid]
    : Math.round((sortedPrices[mid - 1] + sortedPrices[mid]) / 2);

  const minManwon = sortedPrices[0];
  const maxManwon = sortedPrices[sortedPrices.length - 1];
  const areas = allTrades.map(t => t.area).filter(a => a > 0);
  const minArea = areas.length ? Math.min(...areas) : null;
  const maxArea = areas.length ? Math.max(...areas) : null;

  const ratio = depositManwon > 0 ? Number(((depositManwon / medianManwon) * 100).toFixed(1)) : null;

  return {
    status: "OK",
    sampleCount: allTrades.length,
    periodMonths: 6,
    medianManwon,
    minManwon,
    maxManwon,
    minArea,
    maxArea,
    ratio
  };
}

// 4. HUG 상습 채무불이행자 공개명단 조회 및 이름 대조
async function checkHugDefaulterList(landlordName, hugApiKey) {
  if (!landlordName || !landlordName.trim()) {
    return { status: "SKIPPED", message: "임대인 성명이 입력되지 않아 명단 대조를 건너뛰었습니다." };
  }
  if (!hugApiKey) {
    return { status: "NO_KEY", error: "HUG_API_KEY가 설정되지 않았습니다." };
  }

  const url = `https://www.khug.or.kr/defaultOnDebitList.do?API_KEY=${encodeURIComponent(hugApiKey)}`;
  const res = await fetchWithTimeout(url, {}, 10000);
  const data = await res.json();

  // 공식 가이드 오류 처리 (ERROR_CODE 03 / ERROR_MSG NO_DATA 등을 '명단 없음'으로 오인하지 않도록 분리)
  if (data?.ERROR_CODE || (data?.resultCode && data.resultCode !== "00")) {
    return {
      status: "API_ERROR",
      errorCode: data.ERROR_CODE || data.resultCode,
      errorMsg: data.ERROR_MSG || data.resultMsg || "HUG API 오류 응답"
    };
  }

  const list = Array.isArray(data) ? data : (data?.data || data?.list || data?.items || []);
  if (!Array.isArray(list)) {
    return { status: "API_ERROR", errorMsg: "HUG 응답 형식을 해석할 수 없습니다." };
  }

  const cleanTarget = landlordName.trim();
  const matches = list
    .filter(row => String(row.CUST_NM || "").trim() === cleanTarget)
    .map(row => ({
      STDD_DT: row.STDD_DT || "",
      CUST_NM: row.CUST_NM || "",
      AGE: row.AGE || "",
      ADDR: row.ADDR || ""
    }));

  if (matches.length > 0) {
    return {
      status: "MATCH_FOUND",
      matches
    };
  }

  return {
    status: "NO_MATCH",
    stddDt: list[0]?.STDD_DT || ""
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { roadAddr, houseType, targetArea, depositManwon, landlordName } = body;

    if (!roadAddr || !roadAddr.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "도로명주소를 입력해 주세요." })
      };
    }

    const jusoKey = process.env.JUSO_API_KEY;
    const dataGoKrKey = process.env.DATA_GO_KR_KEY;
    const hugApiKey = process.env.HUG_API_KEY;

    const queryTimestamp = new Date().toISOString();

    // 1단계: 주소 -> 법정동코드/지번 변환
    const addrResult = await lookupAddress(roadAddr.trim(), jusoKey);
    if (addrResult.status !== "OK") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          queryTimestamp,
          address: addrResult,
          building: { status: "SKIPPED", error: "주소 코드 변환 실패로 조회하지 못했습니다." },
          trades: { status: "SKIPPED", error: "주소 코드 변환 실패로 조회하지 못했습니다." },
          hug: await checkHugDefaulterList(landlordName, hugApiKey)
        })
      };
    }

    // 2단계: 건축물대장, 실거래가, HUG 명단 병렬 조회
    const [buildingResult, tradesResult, hugResult] = await Promise.all([
      fetchBuildingInfo(addrResult, dataGoKrKey),
      fetchRealEstateTrades(
        addrResult.sigunguCd,
        houseType || "multiplex",
        parseFloat(targetArea) || 0,
        parseFloat(depositManwon) || 0,
        dataGoKrKey
      ),
      checkHugDefaulterList(landlordName, hugApiKey)
    ]);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        queryTimestamp,
        address: addrResult,
        building: buildingResult,
        trades: tradesResult,
        hug: hugResult
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "서버 처리 중 오류가 발생했습니다.", detail: err.message })
    };
  }
};
