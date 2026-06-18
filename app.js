const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const testAlarmBtn = document.getElementById('testAlarmBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const dbValue = document.getElementById('dbValue');
const statusBadge = document.getElementById('statusBadge');
const alarmOverlay = document.getElementById('alarmOverlay');
const eventLog = document.getElementById('eventLog');
const waveCanvas = document.getElementById('waveCanvas');
const waveCtx = waveCanvas.getContext('2d');

const thresholdInput = document.getElementById('thresholdInput');
const durationInput = document.getElementById('durationInput');
const cooldownInput = document.getElementById('cooldownInput');
const alarmVolumeInput = document.getElementById('alarmVolumeInput');
const waveWindowInput = document.getElementById('waveWindowInput');
const calibrationInput = document.getElementById('calibrationInput');

const thresholdLabel = document.getElementById('thresholdLabel');
const durationLabel = document.getElementById('durationLabel');
const cooldownLabel = document.getElementById('cooldownLabel');
const alarmVolumeLabel = document.getElementById('alarmVolumeLabel');
const waveWindowLabel = document.getElementById('waveWindowLabel');
const windowLabel = document.getElementById('windowLabel');
const calibrationLabel = document.getElementById('calibrationLabel');

let audioContext;
let alarmAudioContext;
let analyser;
let microphoneStream;
let source;
let dataArray;
let rafId;
let aboveSince = null;
let eventPeak = 0;
let lastAlarmAt = 0;
let alarmTimer = null;
let isRunning = false;
let soundHistory = [];
let lastSampleAt = 0;
let latestDb = null;

const GRAPH_MIN_DB = 35;
const GRAPH_MAX_DB = 105;
const SAMPLE_INTERVAL_MS = 100;

const updateLabels = () => {
  thresholdLabel.textContent = thresholdInput.value;
  durationLabel.textContent = durationInput.value;
  cooldownLabel.textContent = cooldownInput.value;
  alarmVolumeLabel.textContent = alarmVolumeInput.value;
  waveWindowLabel.textContent = waveWindowInput.value;
  windowLabel.textContent = waveWindowInput.value;
  calibrationLabel.textContent = calibrationInput.value;
  drawWaveform();
};

[thresholdInput, durationInput, cooldownInput, alarmVolumeInput, waveWindowInput, calibrationInput].forEach(input => {
  input.addEventListener('input', updateLabels);
});
updateLabels();

function setStatus(type, text) {
  statusBadge.className = `status-badge ${type}`;
  statusBadge.textContent = text;
}

function approximateDb(rms) {
  if (rms <= 0) return 0;
  // Prototype mapping from browser PCM RMS to a practical display range.
  // This is not a calibrated SPL meter. Use calibrationInput to align with a reference meter.
  const db = 20 * Math.log10(rms) + 100 + Number(calibrationInput.value);
  return Math.max(0, Math.min(120, db));
}

async function startMonitoring() {
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') await audioContext.resume();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.55;

    source = audioContext.createMediaStreamSource(microphoneStream);
    source.connect(analyser);
    dataArray = new Float32Array(analyser.fftSize);

    isRunning = true;
    soundHistory = [];
    latestDb = null;
    lastSampleAt = 0;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('normal', '偵測中');
    monitorLoop();
  } catch (error) {
    console.error(error);
    setStatus('danger', '麥克風未授權');
    alert('無法啟用麥克風。請確認瀏覽器已允許本頁使用麥克風，且建議使用 HTTPS 或 localhost。');
  }
}

function stopMonitoring() {
  isRunning = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (microphoneStream) microphoneStream.getTracks().forEach(track => track.stop());
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  stopAlarmVisual();
  dbValue.textContent = '--';
  aboveSince = null;
  eventPeak = 0;
  latestDb = null;
  soundHistory = [];
  drawWaveform();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('idle', '已停止');
}

function monitorLoop(timestamp = performance.now()) {
  if (!isRunning) return;
  analyser.getFloatTimeDomainData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i += 1) {
    sum += dataArray[i] * dataArray[i];
  }

  const rms = Math.sqrt(sum / dataArray.length);
  const db = approximateDb(rms);
  latestDb = db;
  updateMeter(db);
  evaluateThreshold(db);

  if (timestamp - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    addWaveSample(db);
    lastSampleAt = timestamp;
  }

  drawWaveform();
  rafId = requestAnimationFrame(monitorLoop);
}

function updateMeter(db) {
  dbValue.textContent = Math.round(db);
  const threshold = Number(thresholdInput.value);

  if (db >= threshold) {
    setStatus('warning', '超過門檻');
  } else if (db >= Math.max(0, threshold - 10)) {
    setStatus('warning', '接近門檻');
  } else {
    setStatus('normal', '正常');
  }
}

function evaluateThreshold(db) {
  const threshold = Number(thresholdInput.value);
  const requiredMs = Number(durationInput.value) * 1000;
  const cooldownMs = Number(cooldownInput.value) * 1000;
  const now = Date.now();

  if (db >= threshold) {
    if (!aboveSince) {
      aboveSince = now;
      eventPeak = db;
    }
    eventPeak = Math.max(eventPeak, db);

    if (now - aboveSince >= requiredMs && now - lastAlarmAt >= cooldownMs) {
      lastAlarmAt = now;
      triggerAlarm(eventPeak, now - aboveSince);
      aboveSince = now;
      eventPeak = db;
    }
  } else {
    aboveSince = null;
    eventPeak = 0;
  }
}

function addWaveSample(db) {
  const now = Date.now();
  const windowMs = Number(waveWindowInput.value) * 1000;
  soundHistory.unshift({ t: now, db });
  soundHistory = soundHistory.filter(sample => now - sample.t <= windowMs);
}

function setupCanvas() {
  const rect = waveCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  waveCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  waveCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function yFromDb(db, height, paddingTop, paddingBottom) {
  const clamped = Math.max(GRAPH_MIN_DB, Math.min(GRAPH_MAX_DB, db));
  const ratio = (clamped - GRAPH_MIN_DB) / (GRAPH_MAX_DB - GRAPH_MIN_DB);
  return height - paddingBottom - ratio * (height - paddingTop - paddingBottom);
}

function drawWaveform() {
  setupCanvas();
  const rect = waveCanvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const paddingTop = 22;
  const paddingBottom = 42;
  const now = Date.now();
  const threshold = Number(thresholdInput.value);
  const windowMs = Number(waveWindowInput.value) * 1000;

  waveCtx.clearRect(0, 0, width, height);

  const thresholdY = yFromDb(threshold, height, paddingTop, paddingBottom);
  waveCtx.save();
  waveCtx.setLineDash([7, 7]);
  waveCtx.lineWidth = 1.5;
  waveCtx.strokeStyle = 'rgba(200, 78, 78, 0.75)';
  waveCtx.beginPath();
  waveCtx.moveTo(0, thresholdY);
  waveCtx.lineTo(width, thresholdY);
  waveCtx.stroke();
  waveCtx.setLineDash([]);
  waveCtx.fillStyle = 'rgba(200, 78, 78, 0.88)';
  waveCtx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  waveCtx.fillText(`門檻 ${threshold} dB`, 14, Math.max(16, thresholdY - 8));
  waveCtx.restore();

  if (soundHistory.length < 2) {
    waveCtx.fillStyle = 'rgba(28, 43, 42, 0.38)';
    waveCtx.font = '700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    waveCtx.fillText(isRunning ? '正在收集波形資料…' : '按下「開始偵測」後顯示聲量波形', 22, height / 2);
    return;
  }

  const points = soundHistory
    .map(sample => {
      const age = now - sample.t;
      return {
        x: (age / windowMs) * width,
        y: yFromDb(sample.db, height, paddingTop, paddingBottom),
        db: sample.db
      };
    })
    .filter(point => point.x >= 0 && point.x <= width)
    .sort((a, b) => a.x - b.x);

  if (points.length < 2) return;

  // Soft area below the waveform.
  const gradient = waveCtx.createLinearGradient(0, paddingTop, 0, height - paddingBottom);
  gradient.addColorStop(0, 'rgba(47, 125, 102, 0.20)');
  gradient.addColorStop(1, 'rgba(47, 125, 102, 0.02)');
  waveCtx.fillStyle = gradient;
  waveCtx.beginPath();
  waveCtx.moveTo(points[0].x, height - paddingBottom);
  points.forEach(point => waveCtx.lineTo(point.x, point.y));
  waveCtx.lineTo(points[points.length - 1].x, height - paddingBottom);
  waveCtx.closePath();
  waveCtx.fill();

  // Normal line segments.
  waveCtx.lineWidth = 3;
  waveCtx.lineJoin = 'round';
  waveCtx.lineCap = 'round';
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const isOver = prev.db >= threshold || curr.db >= threshold;
    waveCtx.strokeStyle = isOver ? 'rgba(200, 78, 78, 0.96)' : 'rgba(47, 125, 102, 0.92)';
    waveCtx.beginPath();
    waveCtx.moveTo(prev.x, prev.y);
    waveCtx.lineTo(curr.x, curr.y);
    waveCtx.stroke();
  }

  // Current point at left.
  const latest = points[0];
  waveCtx.fillStyle = latest.db >= threshold ? 'rgba(200, 78, 78, 1)' : 'rgba(47, 125, 102, 1)';
  waveCtx.beginPath();
  waveCtx.arc(latest.x, latest.y, 5, 0, Math.PI * 2);
  waveCtx.fill();
}

function triggerAlarm(peakDb, durationMs) {
  playAlarmSound();
  showAlarmVisual();
  addLogItem(peakDb, durationMs);
}

function showAlarmVisual() {
  document.body.classList.add('alarming');
  alarmOverlay.classList.add('show');
  window.clearTimeout(alarmTimer);
  alarmTimer = window.setTimeout(stopAlarmVisual, 2300);
}

function stopAlarmVisual() {
  document.body.classList.remove('alarming');
  alarmOverlay.classList.remove('show');
}

async function getAlarmContext() {
  if (!alarmAudioContext || alarmAudioContext.state === 'closed') {
    alarmAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (alarmAudioContext.state === 'suspended') {
    await alarmAudioContext.resume();
  }
  return alarmAudioContext;
}

async function playAlarmSound() {
  const volume = Number(alarmVolumeInput.value) / 100;
  if (volume <= 0) return;

  try {
    const ctx = await getAlarmContext();
    const master = ctx.createGain();
    const safeGain = Math.min(0.75, Math.max(0.02, volume * volume * 0.75));
    master.gain.setValueAtTime(safeGain, ctx.currentTime);
    master.connect(ctx.destination);

    const beepSchedule = [0, 0.28, 0.56];
    beepSchedule.forEach((offset, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(index % 2 === 0 ? 988 : 740, ctx.currentTime + offset);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + offset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.19);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(ctx.currentTime + offset);
      oscillator.stop(ctx.currentTime + offset + 0.21);
    });

    window.setTimeout(() => master.disconnect(), 1100);
  } catch (error) {
    console.error('Alarm sound failed:', error);
  }
}

function addLogItem(peakDb, durationMs) {
  const empty = eventLog.querySelector('.empty-log');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'log-item';
  const time = new Date().toLocaleString('zh-TW', { hour12: false });
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  item.innerHTML = `
    <strong>${time}</strong>
    <p>最高聲量約 ${Math.round(peakDb)} dB，連續超標約 ${seconds} 秒。</p>
  `;
  eventLog.prepend(item);
}

function clearLog() {
  eventLog.innerHTML = '<p class="empty-log">尚無超標事件。</p>';
}

startBtn.addEventListener('click', startMonitoring);
stopBtn.addEventListener('click', stopMonitoring);
testAlarmBtn.addEventListener('click', async () => {
  await playAlarmSound();
  showAlarmVisual();
});
clearLogBtn.addEventListener('click', clearLog);
window.addEventListener('resize', drawWaveform);

window.addEventListener('beforeunload', () => {
  if (microphoneStream) microphoneStream.getTracks().forEach(track => track.stop());
});

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  startBtn.disabled = true;
  setStatus('danger', '瀏覽器不支援');
  alert('這個瀏覽器不支援麥克風偵測功能。請改用新版 Chrome、Edge 或 Safari。');
}

drawWaveform();
