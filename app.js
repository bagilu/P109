const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const testAlarmBtn = document.getElementById('testAlarmBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const dbValue = document.getElementById('dbValue');
const meterFill = document.getElementById('meterFill');
const statusBadge = document.getElementById('statusBadge');
const alarmOverlay = document.getElementById('alarmOverlay');
const eventLog = document.getElementById('eventLog');

const thresholdInput = document.getElementById('thresholdInput');
const durationInput = document.getElementById('durationInput');
const cooldownInput = document.getElementById('cooldownInput');
const calibrationInput = document.getElementById('calibrationInput');

const thresholdLabel = document.getElementById('thresholdLabel');
const durationLabel = document.getElementById('durationLabel');
const cooldownLabel = document.getElementById('cooldownLabel');
const calibrationLabel = document.getElementById('calibrationLabel');

let audioContext;
let analyser;
let microphoneStream;
let source;
let dataArray;
let rafId;
let aboveSince = null;
let eventPeak = 0;
let lastAlarmAt = 0;
let alarmTimer = null;
let alarmOscillator = null;
let isRunning = false;

const updateLabels = () => {
  thresholdLabel.textContent = thresholdInput.value;
  durationLabel.textContent = durationInput.value;
  cooldownLabel.textContent = cooldownInput.value;
  calibrationLabel.textContent = calibrationInput.value;
};

[thresholdInput, durationInput, cooldownInput, calibrationInput].forEach(input => {
  input.addEventListener('input', updateLabels);
});
updateLabels();

function setStatus(type, text) {
  statusBadge.className = `status-badge ${type}`;
  statusBadge.textContent = text;
}

function approximateDb(rms) {
  if (rms <= 0) return 0;
  // This maps browser PCM RMS to a practical display range for prototype use.
  // It is not a calibrated sound pressure level meter.
  const db = 20 * Math.log10(rms) + 100 + Number(calibrationInput.value);
  return Math.max(0, Math.min(120, db));
}

async function startMonitoring() {
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.55;

    source = audioContext.createMediaStreamSource(microphoneStream);
    source.connect(analyser);
    dataArray = new Float32Array(analyser.fftSize);

    isRunning = true;
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
  meterFill.style.width = '0%';
  aboveSince = null;
  eventPeak = 0;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('idle', '已停止');
}

function monitorLoop() {
  if (!isRunning) return;
  analyser.getFloatTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i] * dataArray[i];
  }
  const rms = Math.sqrt(sum / dataArray.length);
  const db = approximateDb(rms);
  updateMeter(db);
  evaluateThreshold(db);
  rafId = requestAnimationFrame(monitorLoop);
}

function updateMeter(db) {
  dbValue.textContent = Math.round(db);
  meterFill.style.width = `${Math.min(100, (db / 110) * 100)}%`;

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

function playAlarmSound() {
  const ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, ctx.currentTime);
  oscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.18);
  oscillator.frequency.setValueAtTime(880, ctx.currentTime + 0.36);

  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.65);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.7);
  alarmOscillator = oscillator;
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
testAlarmBtn.addEventListener('click', () => {
  playAlarmSound();
  showAlarmVisual();
});
clearLogBtn.addEventListener('click', clearLog);

window.addEventListener('beforeunload', () => {
  if (microphoneStream) microphoneStream.getTracks().forEach(track => track.stop());
});

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  startBtn.disabled = true;
  setStatus('danger', '瀏覽器不支援');
  alert('這個瀏覽器不支援麥克風偵測功能。請改用新版 Chrome、Edge 或 Safari。');
}
