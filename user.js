// ==UserScript==
// @name         GeoFS ATC Reporter (Enhanced + Flight Info + Takeoff Time + Squawk)
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  傳送玩家位置/航班資訊到 ATC Server；ALT=AGL；UI可輸入Dep/Arr/FlightNo/Squawk；按W收合；自動偵測Takeoff UTC
// @match http://*/geofs.php*
// @match https://*/geofs.php*
// @updateURL   https://github.com/seabus0316/GeoFS-flightradar/raw/refs/heads/main/user.js
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** CONFIG ***/
  const WS_URL = 'ws://localhost:3000/';
  const SEND_INTERVAL_MS = 500;
  /*************/

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

  // --- 全域變數 ---
  let flightInfo = { departure: '', arrival: '', flightNo: '', squawk: '' };
  let flightUI;
  let wasOnGround = true;
  let takeoffTimeUTC = '';

  // --- WebSocket 管理 ---
  let ws;
  function connect() {
    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        log('WS connected');
        safeSend({ type: 'hello', role: 'player' });
      });
      ws.addEventListener('close', () => {
        log('WS closed, retrying...');
        setTimeout(connect, 2000);
      });
      ws.addEventListener('error', (e) => {
        console.warn('[ATC-Reporter] WS error', e);
        try { ws.close(); } catch {}
      });
    } catch (e) {
      console.warn('[ATC-Reporter] WS connect error', e);
      setTimeout(connect, 2000);
    }
  }
  connect();

  function safeSend(obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

  // --- 工具函式 ---
  function getAircraftName() {
    return geofs?.aircraft?.instance?.aircraftRecord?.name || 'Unknown';
  }
  function getPlayerCallsign() {
    return geofs?.userRecord?.callsign || 'Unknown';
  }
  // --- AGL 計算 ---
  function calculateAGL() {
    try {
      const altitudeMSL = geofs?.animation?.values?.altitude;
      const groundElevationFeet = geofs?.animation?.values?.groundElevationFeet;
      const aircraft = geofs?.aircraft?.instance;

      if (
        typeof altitudeMSL === 'number' &&
        typeof groundElevationFeet === 'number' &&
        aircraft?.collisionPoints?.length >= 2 &&
        typeof aircraft.collisionPoints[aircraft.collisionPoints.length - 2]?.worldPosition?.[2] === 'number'
      ) {
        const collisionZFeet = aircraft.collisionPoints[aircraft.collisionPoints.length - 2].worldPosition[2] * 3.2808399;
        return Math.round((altitudeMSL - groundElevationFeet) + collisionZFeet);
      }
    } catch (err) {
      console.warn('[ATC-Reporter] AGL calculation error:', err);
    }
    return null;
  }

  // --- 起飛偵測 ---
  function checkTakeoff() {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
      console.log('[ATC-Reporter] Takeoff at', takeoffTimeUTC);
    }
    wasOnGround = onGround;
  }

  // --- 擷取飛行狀態 ---
  function readSnapshot() {
    try {
      const inst = geofs?.aircraft?.instance;
      if (!inst) return null;

      const lla = inst.llaLocation || [];
      const lat = lla[0];
      const lon = lla[1];
      const altMeters = lla[2];

      if (typeof lat !== 'number' || typeof lon !== 'number') return null;

      const altMSL = (typeof altMeters === 'number') ? altMeters * 3.28084 : geofs?.animation?.values?.altitude ?? 0;
      const altAGL = calculateAGL();
      const heading = geofs?.animation?.values?.heading360 ?? 0;
      const speed =  geofs.animation.values.kias ? geofs.animation.values.kias.toFixed(1) : 'N/A';

      return { lat, lon, altMSL, altAGL, heading, speed };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  // --- 組裝 payload ---
  function buildPayload(snap) {
  checkTakeoff();
  let flightPlan = [];
  try {
    if (geofs.flightPlan && typeof geofs.flightPlan.export === "function") {
      flightPlan = geofs.flightPlan.export();
    }console.log('[ATC-Reporter] FlightPlan:', flightPlan);
  } catch (e) {}
  return {
    id: getPlayerCallsign(),
    callsign: getPlayerCallsign(),
    type: getAircraftName(),
    lat: snap.lat,
    lon: snap.lon,
    alt: (typeof snap.altAGL === 'number') ? snap.altAGL : Math.round(snap.altMSL || 0),
    altMSL: Math.round(snap.altMSL || 0),
    heading: Math.round(snap.heading || 0),
    speed: Math.round(snap.speed || 0),
    flightNo: flightInfo.flightNo,
    departure: flightInfo.departure,
    arrival: flightInfo.arrival,
    takeoffTime: takeoffTimeUTC,
    squawk: flightInfo.squawk,
    flightPlan: flightPlan  // <--- 新增這一行
  };
}

  // --- 定期傳送 ---
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const snap = readSnapshot();
    if (!snap) return;
    const payload = buildPayload(snap);
    safeSend({ type: 'position_update', payload });
  }, SEND_INTERVAL_MS);

  // --- Toast 提示 ---
  function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.background = 'rgba(0,0,0,0.8)';
    toast.style.color = '#fff';
    toast.style.padding = '8px 12px';
    toast.style.borderRadius = '6px';
    toast.style.fontSize = '13px';
    toast.style.zIndex = 1000000;
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // --- UI 注入 ---
function injectFlightUI() {
    // Check if the UI is already injected
    if (document.getElementById('flightInfoUI')) {
        return;
    }

    // 1. Create the main UI container
    flightUI = document.createElement('div');
    flightUI.id = 'flightInfoUI';

    // 2. Modern CSS Styles (Left-Middle Position)
    flightUI.style.position = 'fixed';
    flightUI.style.top = '50%';
    flightUI.style.left = '20px'; // Positioned 20px from the left edge
    flightUI.style.transform = 'translateY(-50%)'; // Vertically center it
    
    // Aesthetic Styles
    flightUI.style.background = 'rgba(25, 30, 45, 0.9)';
    flightUI.style.backdropFilter = 'blur(10px)';
    flightUI.style.padding = '18px';
    flightUI.style.borderRadius = '12px';
    flightUI.style.color = '#EAEAEA';
    flightUI.style.fontFamily = 'Helvetica Neue, Arial, sans-serif';
    flightUI.style.fontSize = '13px';
    flightUI.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.4)';
    flightUI.style.zIndex = 999999;
    flightUI.style.maxWidth = '220px';

    // 3. Structured and Styled Inner HTML
    flightUI.innerHTML = `
      <style>
        /* Embedded styles */
        #flightInfoUI .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            padding-bottom: 5px;
            border-bottom: 1px solid rgba(100, 110, 130, 0.2);
        }

        #flightInfoUI .title {
            font-weight: bold;
            font-size: 14px;
            letter-spacing: 0.5px;
        }
        
        #flightInfoUI #closeBtn {
            background: none;
            border: none;
            color: #FF5C5C; 
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            padding: 0 4px;
            transition: color 0.2s;
        }

        #flightInfoUI #closeBtn:hover {
            color: #FF2B2B;
        }
        
        #flightInfoUI .input-group {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        
        #flightInfoUI input {
            background: rgba(40, 50, 70, 0.9);
            border: 1px solid rgba(100, 110, 130, 0.5);
            color: #EAEAEA;
            padding: 4px 8px;
            border-radius: 6px;
            width: 70px;
            text-align: center;
            transition: all 0.2s ease-in-out;
        }

        #flightInfoUI input:focus {
            border-color: #007AFF;
            outline: none;
            box-shadow: 0 0 0 2px rgba(0, 122, 255, 0.3);
        }
        
        #flightInfoUI button#saveBtn {
            width: 100%;
            padding: 10px;
            margin-top: 12px;
            background-color: #007AFF;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            letter-spacing: 0.5px;
            transition: background-color 0.2s, transform 0.1s;
        }

        #flightInfoUI button#saveBtn:hover {
            background-color: #005BB5;
        }
        
        #flightInfoUI button#saveBtn:active {
            transform: scale(0.98);
        }
      </style>

      <div class="header">
        <span class="title">✈️ Flight Data Entry</span>
        <button id="closeBtn">W</button>
      </div>

      <div class="input-group">
        <label for="depInput">Departure:</label> 
        <input id="depInput" maxlength="4">
      </div>
      <div class="input-group">
        <label for="arrInput">Arrival:</label> 
        <input id="arrInput" maxlength="4">
      </div>
      <div class="input-group">
        <label for="fltInput">Flight #:</label> 
        <input id="fltInput" maxlength="5">
      </div>
      <div class="input-group">
        <label for="sqkInput">Squawk:</label> 
        <input id="sqkInput" maxlength="4">
      </div>
      <button id="saveBtn">Save Info</button>
    `;

    document.body.appendChild(flightUI);

    // 4. Input Listeners: Auto-Capitalization (Original functionality restored)
    const inputIds = ['depInput', 'arrInput', 'fltInput', 'sqkInput'];
    inputIds.forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => {
        el.value = el.value.toUpperCase(); // Ensure ALL inputs auto-capitalize
      });
    });
    
    // 5. Close Button Listener ('W' button functionality)
    document.getElementById('closeBtn').onclick = () => {
        if (flightUI) {
            flightUI.style.display = 'none'; // Hide the UI
        }
    };

    // 6. Save Button Logic (Original saving logic restored)
    document.getElementById('saveBtn').onclick = () => {
      flightInfo.departure = document.getElementById('depInput').value.trim();
      flightInfo.arrival = document.getElementById('arrInput').value.trim();
      flightInfo.flightNo = document.getElementById('fltInput').value.trim();
      flightInfo.squawk = document.getElementById('sqkInput').value.trim();
      
      // Call the global toast function
      showToast('Flight info saved!');
    };
}

// Inject the UI on script load
injectFlightUI();

// Call the function to inject the UI
injectFlightUI();
  // --- 快捷鍵 W 收合 UI ---
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'w') {
      if (flightUI.style.display === 'none') {
        flightUI.style.display = 'block';
        showToast('Flight Info UI Shown');
      } else {
        flightUI.style.display = 'none';
        showToast('Flight Info UI Hidden');
      }
    }
  });

  // --- 關閉所有 input 的 autocomplete ---
  document.querySelectorAll("input").forEach(el => {
    el.setAttribute("autocomplete", "off");
  });

  // --- 防止 input 觸發 GeoFS hotkey ---
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      e.stopPropagation();
    }
  }, true);

})();