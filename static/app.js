// ChemiQuant — Frontend Application Logic
// Image Acquisition, 5x5 ROI Measurement, Improved Graphing & Clean Error Management

const state = {
  uploadId: null,
  kind: null,
  filename: 'sample.tif',
  meta: {},
  lastFrame: null,
  lastResultId: null,
  library: [],
  activeAnalyte: null,

  // Acquire & ROI Workflow State
  imageObj: null,
  imageLoaded: false,
  origWidth: 0,
  origHeight: 0,
  prominence: 100,
  manualSelectionEnabled: false, // Step 3: locked immediately after acquisition
  roiList: [],
  currentRoi: { x: 0, y: 0, width: 5, height: 5, area: 25 },
  lastMeasurement: null,
  lastPrediction: null
};

// ---------------------------------------------------------------------------
// 2. Clean, Compact Error Management (Deduplicated, Short, Relevant)
// ---------------------------------------------------------------------------
let errorTimer = null;
let currentErrorMessage = '';

function showError(msg) {
  if (!msg) return;
  // Prevent repeating identical error spam
  if (currentErrorMessage === msg) return;
  currentErrorMessage = msg;

  const banner = document.getElementById('error-section');
  const msgEl = document.getElementById('error-message');
  if (!banner || !msgEl) return;

  msgEl.textContent = msg;
  banner.classList.remove('hidden');

  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    hideError();
  }, 6000);
}

function hideError() {
  const banner = document.getElementById('error-section');
  if (banner) banner.classList.add('hidden');
  currentErrorMessage = '';
  if (errorTimer) clearTimeout(errorTimer);
}

document.getElementById('error-close-btn').addEventListener('click', hideError);

// ---------------------------------------------------------------------------
// Tab Navigation
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('section.card').forEach(x => x.classList.add('hidden'));
    b.classList.add('active');
    document.getElementById('tab-' + b.dataset.tab).classList.remove('hidden');

    if (b.dataset.tab === 'calibrate') {
      const activeCurve = state.library.find(c => c.analyte === document.getElementById('analyte-lib').value) || state.library[0];
      if (activeCurve) {
        setTimeout(() => loadCalibrationInto(activeCurve), 50);
      }
    } else if (b.dataset.tab === 'results') {
      loadHistory();
      if (state.lastPrediction) {
        setTimeout(() => renderResultGraph(state.lastPrediction), 50);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Library & Analyte Selection
// ---------------------------------------------------------------------------
async function loadLibrary() {
  try {
    const res = await fetch('/api/library');
    state.library = await res.json();
    const libSel = document.getElementById('analyte-lib');
    const activeSel = document.getElementById('active-analyte');
    libSel.innerHTML = '';
    activeSel.innerHTML = '';

    state.library.forEach(c => {
      const label = c.analyte.replace(/_/g, ' ');
      libSel.appendChild(new Option(label, c.analyte));
      activeSel.appendChild(new Option(label, c.analyte));
    });
    libSel.appendChild(new Option('+ new custom analyte…', '__new__'));

    state.activeAnalyte = state.library[0]?.analyte;
    updateActiveAnalyteInfo();
    loadCalibrationInto(state.library[0]);
  } catch (err) {
    showError('Unable to load calibration library.');
  }
}

function updateActiveAnalyteInfo() {
  const analyte = document.getElementById('active-analyte').value;
  state.activeAnalyte = analyte;
  const curve = state.library.find(c => c.analyte === analyte);
  const infoEl = document.getElementById('active-cal-eqn');
  if (curve && curve.slope != null) {
    infoEl.textContent = `c = ${curve.slope.toFixed(4)}·I + ${curve.intercept.toFixed(3)} (${curve.units}, R²=${curve.r2.toFixed(4)})`;
  } else {
    infoEl.textContent = 'Uncalibrated';
  }
}

document.getElementById('active-analyte').addEventListener('change', updateActiveAnalyteInfo);

document.getElementById('analyte-lib').addEventListener('change', e => {
  if (e.target.value === '__new__') {
    const name = prompt('Name this new analyte (alphanumeric/underscores):', 'custom_analyte');
    if (!name) {
      e.target.value = state.library[0]?.analyte || '';
      return;
    }
    const cleanName = name.trim().toLowerCase().replace(/\s+/g, '_');
    const opt = new Option(cleanName.replace(/_/g, ' '), cleanName);
    e.target.insertBefore(opt, e.target.lastChild);
    e.target.value = cleanName;
    document.querySelector('#cal-table tbody').innerHTML = '';
    addRow(); addRow(); addRow();
    document.getElementById('conc-units').value = 'µM';
    resetCalStats();
    return;
  }
  const curve = state.library.find(c => c.analyte === e.target.value);
  loadCalibrationInto(curve);
});

function resetCalStats() {
  document.getElementById('stat-slope').textContent = '—';
  document.getElementById('stat-intercept').textContent = '—';
  document.getElementById('stat-r2').textContent = '—';
  const c = document.getElementById('cal-canvas');
  if (c) {
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
  }
}

function loadCalibrationInto(curve) {
  const tbody = document.querySelector('#cal-table tbody');
  tbody.innerHTML = '';
  if (!curve) { resetCalStats(); return; }
  document.getElementById('conc-units').value = curve.units || 'µM';
  (curve.points || []).forEach(([c, i]) => addRow(c, i));
  if (curve.slope != null) {
    document.getElementById('stat-slope').textContent = curve.slope.toFixed(4);
    document.getElementById('stat-intercept').textContent = curve.intercept.toFixed(3);
    document.getElementById('stat-r2').textContent = curve.r2.toFixed(4);
    drawScientificPlot('cal-canvas', curve.points, curve.slope, curve.intercept, curve.r2, curve.analyte, curve.units);
  }
}

function addRow(c = '', i = '') {
  const tbody = document.querySelector('#cal-table tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="number" step="any" class="c-val" value="${c}" placeholder="0.0"></td>
    <td><input type="number" step="any" class="i-val" value="${i}" placeholder="0.0"></td>
    <td><button class="btn ghost del" title="Remove row">✕</button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
}
document.getElementById('add-row').addEventListener('click', () => addRow());

document.getElementById('save-cal').addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('#cal-table tbody tr')].map(tr => [
    parseFloat(tr.querySelector('.c-val').value),
    parseFloat(tr.querySelector('.i-val').value)
  ]).filter(([c, i]) => !isNaN(c) && !isNaN(i));

  if (rows.length < 2) {
    showError('At least 2 calibration standards are required to fit a curve.');
    return;
  }

  const analyte = document.getElementById('analyte-lib').value;
  const units = document.getElementById('conc-units').value.trim() || 'µM';

  try {
    const res = await fetch('/api/calibration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analyte, units, points: rows })
    });
    const data = await res.json();
    if (data.error) { showError(data.error); return; }

    document.getElementById('stat-slope').textContent = data.slope.toFixed(4);
    document.getElementById('stat-intercept').textContent = data.intercept.toFixed(3);
    document.getElementById('stat-r2').textContent = data.r2.toFixed(4);

    drawScientificPlot('cal-canvas', data.points, data.slope, data.intercept, data.r2, data.analyte, data.units);
    await loadLibrary();
    document.getElementById('analyte-lib').value = analyte;
  } catch (err) {
    showError('Failed to save calibration standards.');
  }
});

// ---------------------------------------------------------------------------
// 1. EXACT IMAGE ACQUISITION & 5x5 ROI WORKFLOW
// ---------------------------------------------------------------------------

// Trigger file input
const dz = document.getElementById('dz-file');
dz.addEventListener('click', e => {
  if (e.target.id === 'load-sample-btn') return;
  document.getElementById('file-input').click();
});

// Load sample demo image
document.getElementById('load-sample-btn').addEventListener('click', async e => {
  e.stopPropagation();
  try {
    const res = await fetch('/api/sample');
    const data = await res.json();
    if (data.error) { showError(data.error); return; }
    handleUploadSuccess(data);
  } catch (err) {
    showError('Could not load sample image.');
  }
});

// File upload handler
document.getElementById('file-input').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('file', f);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { showError(data.error); return; }
    handleUploadSuccess(data);
  } catch (err) {
    showError('Error uploading file. Please try again.');
  }
});

async function handleUploadSuccess(data) {
  state.uploadId = data.upload_id;
  state.kind = data.kind;
  state.meta = data;
  state.filename = data.filename || 'sample.tif';

  // Reset measurements & ROI
  state.roiList = [];
  state.manualSelectionEnabled = false; // Rule 3: Manual selection locked immediately after acquisition
  updateRoiListBox();
  document.getElementById('measurement-results-section').classList.add('hidden');
  document.getElementById('roi-btn-measure').disabled = true;

  const scrub = document.getElementById('scrub-controls');
  const slider = document.getElementById('scrub-slider');
  const label = document.getElementById('scrub-label');

  if (data.kind === 'image') {
    scrub.classList.add('hidden');
    await loadFrameData({});
  } else if (data.kind === 'gif') {
    scrub.classList.remove('hidden');
    label.textContent = `Scrub frames (0–${data.frame_count - 1})`;
    slider.min = 0; slider.max = Math.max(0, data.frame_count - 1); slider.step = 1; slider.value = 0;
    await loadFrameData({ frame: 0 });
  } else {
    scrub.classList.remove('hidden');
    label.textContent = `Scrub to peak-emission frame (0–${data.duration.toFixed(1)}s)`;
    slider.min = 0; slider.max = data.duration; slider.step = 0.05; slider.value = 0;
    await loadFrameData({ t: 0 });
  }
}

document.getElementById('scrub-slider').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (state.kind === 'gif') loadFrameData({ frame: Math.round(v) });
  else loadFrameData({ t: v });
});

// Load Frame Data & Render onto Interactive Canvas
async function loadFrameData(params) {
  params.prominence = state.prominence;
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`/api/frame/${state.uploadId}${qs ? '?' + qs : ''}`);
    const data = await res.json();
    if (data.error) { showError(data.error); return; }

    state.lastFrame = data;
    state.origWidth = data.width;
    state.origHeight = data.height;
    if (data.filename) state.filename = data.filename;

    document.getElementById('displayed-filename').textContent = state.filename;
    document.getElementById('displayed-dims').textContent = `${data.width} × ${data.height} px`;
    document.getElementById('acquisition-area').classList.remove('hidden');

    // Rule 3: Do not provide manual selection immediately after image acquisition
    state.manualSelectionEnabled = false;
    updateSelectionBadge();

    // Render image to canvas
    const img = new Image();
    img.onload = () => {
      state.imageObj = img;
      renderDisplayCanvas();
    };
    img.src = data.preview;

  } catch (err) {
    showError('Failed to load acquired image frame.');
  }
}

// Canvas rendering with HiDPI support & 5x5 ROI box overlay
function renderDisplayCanvas() {
  const canvas = document.getElementById('display-canvas');
  if (!canvas || !state.imageObj) return;

  const ctx = canvas.getContext('2d');
  const containerWidth = canvas.parentElement.clientWidth || 600;
  const maxW = Math.min(containerWidth, 760);
  const aspect = state.origHeight / state.origWidth;
  const displayW = maxW;
  const displayH = Math.round(maxW * aspect);

  canvas.width = displayW;
  canvas.height = displayH;
  ctx.drawImage(state.imageObj, 0, 0, displayW, displayH);

  // If an ROI is specified, draw the 5x5 ROI box on the canvas
  if (state.currentRoi && state.roiList.length > 0) {
    const scaleX = displayW / state.origWidth;
    const scaleY = displayH / state.origHeight;

    const rx = state.currentRoi.x * scaleX;
    const ry = state.currentRoi.y * scaleY;
    const rw = Math.max(state.currentRoi.width * scaleX, 10); // ensure clearly visible on screen
    const rh = Math.max(state.currentRoi.height * scaleY, 10);

    // Crosshair target
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    // High contrast border
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(rx - 1, ry - 1, rw + 2, rh + 2);

    // Tag
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(rx, Math.max(0, ry - 18), 70, 16);
    ctx.fillStyle = '#facc15';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText('ROI (5×5)', rx + 4, Math.max(12, ry - 6));
  }
}

function updateSelectionBadge() {
  const badge = document.getElementById('selection-status-badge');
  const canvas = document.getElementById('display-canvas');
  if (state.manualSelectionEnabled) {
    badge.className = 'selection-badge active';
    badge.textContent = '● Manual Selection Active: Click on image to position 5×5 ROI';
    canvas.classList.add('active-crosshair');
  } else {
    badge.className = 'selection-badge locked';
    badge.textContent = 'Manual Selection: Disabled (Follow workflow steps below)';
    canvas.classList.remove('active-crosshair');
  }
}

// Step 1: Prominence Selection
document.getElementById('prominence-input').addEventListener('input', e => {
  const val = parseFloat(e.target.value);
  if (!isNaN(val) && val > 0) {
    state.prominence = val;
  }
});

// Step 2: Open ROI Manager
document.getElementById('btn-open-roi-manager').addEventListener('click', () => {
  const panel = document.getElementById('roi-manager-panel');
  panel.classList.toggle('hidden');
});
document.getElementById('roi-panel-close').addEventListener('click', () => {
  document.getElementById('roi-manager-panel').classList.add('hidden');
});

// Step 3: ROI Manager: Click Add
document.getElementById('roi-btn-add').addEventListener('click', () => {
  const idx = state.roiList.length + 1;
  const defaultX = Math.round(state.origWidth / 2 - 2);
  const defaultY = Math.round(state.origHeight / 2 - 2);

  const newRoi = {
    id: `000${idx}-0005-0005`,
    name: `ROI ${idx} (5×5)`,
    x: Math.max(0, defaultX),
    y: Math.max(0, defaultY),
    width: 5,
    height: 5,
    area: 25
  };
  state.roiList.push(newRoi);
  state.currentRoi = { ...newRoi };
  updateRoiListBox();
  document.getElementById('roi-btn-delete').disabled = false;
});

function updateRoiListBox() {
  const select = document.getElementById('roi-items-list');
  select.innerHTML = '';
  state.roiList.forEach((roi, idx) => {
    const opt = new Option(`${roi.name} [X:${roi.x}, Y:${roi.y}]`, idx);
    select.appendChild(opt);
  });
  if (state.roiList.length > 0) {
    select.selectedIndex = state.roiList.length - 1;
  }
}

// Step 4: ROI Manager: More -> Specify
const roiBtnMore = document.getElementById('roi-btn-more');
const roiMoreDropdown = document.getElementById('roi-more-dropdown');

roiBtnMore.addEventListener('click', e => {
  e.stopPropagation();
  roiMoreDropdown.classList.toggle('hidden');
  if (!roiMoreDropdown.classList.contains('hidden')) {
    roiMoreDropdown.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});
window.addEventListener('click', e => {
  if (roiMoreDropdown && !roiMoreDropdown.classList.contains('hidden')) {
    if (!roiMoreDropdown.contains(e.target) && e.target !== roiBtnMore) {
      roiMoreDropdown.classList.add('hidden');
    }
  }
});

document.getElementById('roi-menu-specify').addEventListener('click', () => {
  document.getElementById('roi-more-dropdown').classList.add('hidden');
  if (state.roiList.length === 0) {
    // If user hasn't clicked Add yet, add automatically as part of the sequence
    document.getElementById('roi-btn-add').click();
  }
  // Populate Specify modal
  document.getElementById('specify-w').value = 5;
  document.getElementById('specify-h').value = 5;
  document.getElementById('specify-x').value = state.currentRoi.x;
  document.getElementById('specify-y').value = state.currentRoi.y;
  document.getElementById('specify-modal').classList.remove('hidden');
});

document.getElementById('specify-close-btn').addEventListener('click', () => {
  document.getElementById('specify-modal').classList.add('hidden');
});

// Confirm Specify: set 5x5 ROI & UNLOCK manual positioning on the image
document.getElementById('btn-apply-specify').addEventListener('click', () => {
  const sx = parseInt(document.getElementById('specify-x').value) || 0;
  const sy = parseInt(document.getElementById('specify-y').value) || 0;

  state.currentRoi.width = 5;
  state.currentRoi.height = 5;
  state.currentRoi.area = 25;
  state.currentRoi.x = Math.max(0, Math.min(sx, state.origWidth - 5));
  state.currentRoi.y = Math.max(0, Math.min(sy, state.origHeight - 5));

  // Step 4.6: Manual selection is now enabled on the image!
  state.manualSelectionEnabled = true;
  updateSelectionBadge();
  document.getElementById('specify-modal').classList.add('hidden');
  document.getElementById('loupe-panel').classList.remove('hidden');
  document.getElementById('roi-btn-measure').disabled = false;

  updateCoordinatesDisplay();
  renderDisplayCanvas();
  updatePixelLoupe();
});

// Manual Positioning on Image (Click & Drag)
const dispCanvas = document.getElementById('display-canvas');

function positionRoiAtEvent(e) {
  if (!state.manualSelectionEnabled || !state.origWidth || !state.origHeight) return;
  const rect = dispCanvas.getBoundingClientRect();
  const scaleX = state.origWidth / rect.width;
  const scaleY = state.origHeight / rect.height;

  const clickX = (e.clientX - rect.left) * scaleX;
  const clickY = (e.clientY - rect.top) * scaleY;

  // Center the 5x5 ROI on the cursor point
  const roiX = Math.round(clickX - 2.5);
  const roiY = Math.round(clickY - 2.5);

  state.currentRoi.x = Math.max(0, Math.min(roiX, state.origWidth - 5));
  state.currentRoi.y = Math.max(0, Math.min(roiY, state.origHeight - 5));
  state.currentRoi.width = 5;
  state.currentRoi.height = 5;
  state.currentRoi.area = 25;

  if (state.roiList.length > 0) {
    const selIdx = document.getElementById('roi-items-list').selectedIndex;
    const targetIdx = selIdx >= 0 ? selIdx : 0;
    if (state.roiList[targetIdx]) {
      state.roiList[targetIdx].x = state.currentRoi.x;
      state.roiList[targetIdx].y = state.currentRoi.y;
      updateRoiListBox();
    }
  }

  updateCoordinatesDisplay();
  renderDisplayCanvas();
  updatePixelLoupe();
}

let isDragging = false;
dispCanvas.addEventListener('mousedown', e => {
  if (!state.manualSelectionEnabled) return;
  isDragging = true;
  positionRoiAtEvent(e);
});
window.addEventListener('mousemove', e => {
  if (isDragging) positionRoiAtEvent(e);
});
window.addEventListener('mouseup', () => { isDragging = false; });

dispCanvas.addEventListener('click', e => {
  if (!state.manualSelectionEnabled) return;
  positionRoiAtEvent(e);
});

function updateCoordinatesDisplay() {
  const coordText = `X: ${state.currentRoi.x}, Y: ${state.currentRoi.y} (5 × 5 px)`;
  document.getElementById('roi-coords-text').textContent = coordText;
  document.getElementById('loupe-coords').textContent = coordText;
}

// 5x5 Pixel Loupe (Magnifier showing all 25 pixels)
function updatePixelLoupe() {
  const loupeCanvas = document.getElementById('loupe-canvas');
  if (!loupeCanvas || !state.imageObj) return;

  const lctx = loupeCanvas.getContext('2d');
  lctx.clearRect(0, 0, loupeCanvas.width, loupeCanvas.height);

  // Draw 5x5 region scaled 24x to fit 120x120 canvas
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(
    state.imageObj,
    (state.currentRoi.x / state.origWidth) * state.imageObj.width,
    (state.currentRoi.y / state.origHeight) * state.imageObj.height,
    (5 / state.origWidth) * state.imageObj.width,
    (5 / state.origHeight) * state.imageObj.height,
    0, 0, 120, 120
  );

  // Draw 5x5 grid lines
  lctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  lctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    lctx.beginPath();
    lctx.moveTo(i * 24, 0); lctx.lineTo(i * 24, 120);
    lctx.moveTo(0, i * 24); lctx.lineTo(120, i * 24);
    lctx.stroke();
  }
}

// Delete ROI button
document.getElementById('roi-btn-delete').addEventListener('click', () => {
  const select = document.getElementById('roi-items-list');
  const selIdx = select.selectedIndex;
  if (selIdx >= 0) {
    state.roiList.splice(selIdx, 1);
    updateRoiListBox();
    if (state.roiList.length === 0) {
      document.getElementById('roi-btn-delete').disabled = true;
      document.getElementById('roi-btn-measure').disabled = true;
      state.manualSelectionEnabled = false;
      updateSelectionBadge();
      renderDisplayCanvas();
    }
  }
});

// Step 7: Click Measure
document.getElementById('roi-btn-measure').addEventListener('click', measureRoi);

async function measureRoi() {
  if (!state.uploadId) {
    showError('Please acquire an image first.');
    return;
  }

  const payload = {
    upload_id: state.uploadId,
    x: state.currentRoi.x,
    y: state.currentRoi.y,
    width: 5,
    height: 5,
    prominence: state.prominence,
    filename: state.filename
  };

  if (state.kind === 'gif') {
    payload.frame = parseInt(document.getElementById('scrub-slider').value) || 0;
  } else if (state.kind === 'video') {
    payload.t = parseFloat(document.getElementById('scrub-slider').value) || 0;
  }

  try {
    const res = await fetch('/api/measure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.error) { showError(data.error); return; }

    state.lastMeasurement = data;
    renderMeasurementResults(data);
  } catch (err) {
    showError('Failed to perform ROI measurement.');
  }
}

// Render Results Table (Image Name, Area: 25, Mean, StdDev, Min, Max)
function renderMeasurementResults(m) {
  const tbody = document.getElementById('measurement-results-tbody');
  tbody.innerHTML = `
    <tr>
      <td>1</td>
      <td><strong>${m.image_name}</strong></td>
      <td>${m.area}</td>
      <td style="color:var(--glow);font-weight:600">${m.mean_intensity.toFixed(2)}</td>
      <td>${m.std_dev.toFixed(2)}</td>
      <td>${m.min_intensity.toFixed(2)}</td>
      <td>${m.max_intensity.toFixed(2)}</td>
    </tr>
  `;

  // Step 5: Clearly display the final mean intensity value
  document.getElementById('final-mean-intensity-val').textContent = `${m.mean_intensity.toFixed(2)} a.u.`;
  document.getElementById('measurement-results-section').classList.remove('hidden');

  // Scroll smoothly to results
  document.getElementById('measurement-results-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Use Measured Mean Intensity -> Predict Concentration
document.getElementById('use-measured-intensity-btn').addEventListener('click', async () => {
  if (!state.lastMeasurement) return;

  const analyte = document.getElementById('active-analyte').value;
  try {
    const res = await fetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analyte,
        intensity: state.lastMeasurement.mean_intensity
      })
    });
    const data = await res.json();
    if (data.error) { showError(data.error); return; }

    state.lastResultId = data.id;
    state.lastPrediction = data;
    renderResult(data);
    document.querySelector('[data-tab="results"]').click();
  } catch (err) {
    showError('Failed to predict concentration.');
  }
});

// ---------------------------------------------------------------------------
// 3. IMPROVED PUBLICATION-QUALITY SCIENTIFIC GRAPH
// Clear X & Y axis labels, meaningful titles, tick marks, numbers, scaling
// ---------------------------------------------------------------------------
function calculateNiceTicks(minVal, maxVal, targetTicks = 6) {
  const range = maxVal - minVal || 1;
  const rawStep = range / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;

  let step;
  if (residual <= 1.5) step = 1 * magnitude;
  else if (residual <= 3) step = 2 * magnitude;
  else if (residual <= 7) step = 5 * magnitude;
  else step = 10 * magnitude;

  const startTick = Math.floor(minVal / step) * step;
  const ticks = [];
  for (let t = startTick; t <= maxVal + step * 0.5; t += step) {
    ticks.push(parseFloat(t.toFixed(4)));
  }
  return { ticks, min: ticks[0], max: ticks[ticks.length - 1], step };
}

function drawScientificPlot(canvasId, points, m, b, r2, analyteName, units, samplePoint = null) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || 600;
  const height = 320;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  if (!points || !points.length) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No calibration standards available.', width / 2, height / 2);
    return;
  }

  // Points: [conc, intensity]
  // Analytical chemistry standard: X-axis = Concentration, Y-axis = C.L Intensity (a.u)
  const concs = points.map(p => p[0]);
  const intensities = points.map(p => p[1]);
  if (samplePoint) {
    concs.push(samplePoint.concentration);
    intensities.push(samplePoint.intensity);
  }

  const rawXMin = Math.min(0, ...concs);
  const rawXMax = Math.max(...concs) * 1.05 || 1;
  const rawYMin = Math.min(0, ...intensities);
  const rawYMax = Math.max(...intensities) * 1.08 || 1;

  const xTickData = calculateNiceTicks(rawXMin, rawXMax, 6);
  const yTickData = calculateNiceTicks(rawYMin, rawYMax, 6);

  const padLeft = 75;
  const padRight = 35;
  const padTop = 38;
  const padBottom = 55;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const X = v => padLeft + ((v - xTickData.min) / (xTickData.max - xTickData.min)) * plotW;
  const Y = v => padTop + plotH - ((v - yTickData.min) / (yTickData.max - yTickData.min)) * plotH;

  // Draw Grid Lines
  ctx.strokeStyle = '#f1f5f9';
  ctx.lineWidth = 1;
  xTickData.ticks.forEach(t => {
    ctx.beginPath();
    ctx.moveTo(X(t), padTop);
    ctx.lineTo(X(t), padTop + plotH);
    ctx.stroke();
  });
  yTickData.ticks.forEach(t => {
    ctx.beginPath();
    ctx.moveTo(padLeft, Y(t));
    ctx.lineTo(padLeft + plotW, Y(t));
    ctx.stroke();
  });

  // Draw Axes
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Y-axis
  ctx.moveTo(padLeft, padTop);
  ctx.lineTo(padLeft, padTop + plotH);
  // X-axis
  ctx.lineTo(padLeft + plotW, padTop + plotH);
  ctx.stroke();

  // Tick marks & Tick labels
  ctx.fillStyle = '#334155';
  ctx.font = '11.5px "JetBrains Mono", monospace';

  // X ticks & numerical labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  xTickData.ticks.forEach(t => {
    const px = X(t);
    // tick mark
    ctx.beginPath();
    ctx.moveTo(px, padTop + plotH);
    ctx.lineTo(px, padTop + plotH + 5);
    ctx.stroke();
    // label
    ctx.fillText(t.toString(), px, padTop + plotH + 8);
  });

  // Y ticks & numerical labels
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  yTickData.ticks.forEach(t => {
    const py = Y(t);
    // tick mark
    ctx.beginPath();
    ctx.moveTo(padLeft - 5, py);
    ctx.lineTo(padLeft, py);
    ctx.stroke();
    // label
    ctx.fillText(t.toString(), padLeft - 9, py);
  });

  // Clear Meaningful Axis Titles
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 13px "Inter", sans-serif';

  // X-Axis Title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Concentration (${units || 'µM'})`, padLeft + plotW / 2, height - 10);

  // Y-Axis Title (Rotated 90 degrees)
  ctx.save();
  ctx.translate(22, padTop + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('C.L Intensity (a.u)', 0, 0);
  ctx.restore();

  // Descriptive Graph Header / Title
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const cleanAnalyte = (analyteName || 'Analyte').replace(/_/g, ' ');
  ctx.fillText(`Calibration Curve: ${cleanAnalyte}`, padLeft, 12);

  // Regression Equation & R² in top right
  if (m != null && r2 != null) {
    ctx.textAlign = 'right';
    ctx.font = '500 11.5px "JetBrains Mono", monospace';
    ctx.fillStyle = '#2563eb';
    ctx.fillText(`c = ${m.toFixed(4)}·I + ${b.toFixed(3)}  (R² = ${r2.toFixed(4)})`, padLeft + plotW, 14);
  }

  // Draw Linear Regression Fit Line
  if (m != null && m !== 0) {
    ctx.strokeStyle = '#dc2626'; // Bold red line matching reference image
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    const xStart = xTickData.min;
    const xEnd = xTickData.max;
    // Intensity = (c - b) / m
    const yStart = (xStart - b) / m;
    const yEnd = (xEnd - b) / m;
    ctx.moveTo(X(xStart), Y(yStart));
    ctx.lineTo(X(xEnd), Y(yEnd));
    ctx.stroke();
  }

  // Plot Calibration Standard Data Points (Black filled squares matching reference image)
  points.forEach(([cVal, iVal]) => {
    const px = X(cVal);
    const py = Y(iVal);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(px - 4.5, py - 4.5, 9, 9);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(px - 4.5, py - 4.5, 9, 9);
  });

  // Highlight Measured Sample Point if present
  if (samplePoint) {
    const spX = X(samplePoint.concentration);
    const spY = Y(samplePoint.intensity);

    // Glowing highlight circle
    ctx.fillStyle = 'rgba(37, 99, 235, 0.2)';
    ctx.beginPath();
    ctx.arc(spX, spY, 14, 0, Math.PI * 2);
    ctx.fill();

    // Solid star / diamond
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(spX, spY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Sample Callout Tag
    ctx.fillStyle = '#1e3a8a';
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`★ Sample (${samplePoint.concentration.toFixed(2)} ${units}, ${samplePoint.intensity.toFixed(1)} a.u)`, spX + 10, spY - 6);
  }
}

// ---------------------------------------------------------------------------
// Results & Email Delivery
// ---------------------------------------------------------------------------
function renderResult(r) {
  const badge = document.getElementById('fit-badge');
  badge.classList.remove('hidden');
  badge.textContent = r.r2 >= 0.95 ? `R² = ${r.r2.toFixed(4)} · High Fit Quality` : `R² = ${r.r2.toFixed(4)} · Low Calibration Fit`;

  document.getElementById('result-value').textContent = r.concentration.toFixed(3);
  document.getElementById('result-unit').textContent = `Estimated Concentration (${r.units})`;
  document.getElementById('r-analyte').textContent = r.analyte.replace(/_/g, ' ');
  document.getElementById('r-intensity').textContent = `${r.intensity.toFixed(2)} a.u.`;
  document.getElementById('r-equation').textContent = `c = ${r.slope.toFixed(4)} · I + ${r.intercept.toFixed(3)}`;
  document.getElementById('r-r2').textContent = r.r2.toFixed(4);
  document.getElementById('r-time').textContent = r.created_at;

  renderResultGraph(r);
}

function renderResultGraph(r) {
  const curve = state.library.find(c => c.analyte === r.analyte);
  if (!curve) return;

  drawScientificPlot(
    'result-canvas',
    curve.points,
    r.slope,
    r.intercept,
    r.r2,
    r.analyte,
    r.units,
    { concentration: r.concentration, intensity: r.intensity }
  );
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatEmailReport(r) {
  const dateStr = r.created_at || new Date().toISOString().replace('T', ' ').substring(0, 19);
  const analyteName = (r.analyte || 'Unknown').replace(/_/g, ' ');
  const subject = `ChemiQuant Result: ${analyteName} (${dateStr})`;
  const body = `ChemiQuant Measurement Result — ${dateStr}\n\n` +
    `Analyte: ${analyteName}\n` +
    `Measured Mean Intensity: ${Number(r.intensity || 0).toFixed(2)} a.u.\n` +
    `Calibration Equation: c = ${Number(r.slope || 0).toFixed(4)} * I + ${Number(r.intercept || 0).toFixed(3)}  (R² = ${Number(r.r2 || 0).toFixed(4)})\n` +
    `Estimated Concentration: ${Number(r.concentration || 0).toFixed(3)} ${r.units || 'units'}\n\n` +
    `Generated by ChemiQuant Chemiluminometer Concentration Analyzer`;
  return { subject, body };
}

document.getElementById('send-email-btn').addEventListener('click', async () => {
  const to = document.getElementById('email-to').value.trim();
  const status = document.getElementById('email-status');

  if (!to) {
    showError('Please enter a recipient email address.');
    document.getElementById('email-to').focus();
    return;
  }

  // If state.lastResultId is not set, recover latest result from /api/results
  if (!state.lastResultId || !state.lastPrediction) {
    try {
      const res = await fetch('/api/results');
      const rows = await res.json();
      if (rows && rows.length > 0) {
        state.lastResultId = rows[0].id;
        state.lastPrediction = rows[0];
      }
    } catch (_) {}
  }

  if (!state.lastResultId || !state.lastPrediction) {
    showError('Please generate or select a measurement result first.');
    return;
  }

  const { subject, body } = formatEmailReport(state.lastPrediction);
  const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  status.className = 'email-action-box info';
  status.innerHTML = `<div>Sending email to <strong>${escapeHtml(to)}</strong>...</div>`;
  status.classList.remove('hidden');

  try {
    const res = await fetch('/api/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, result_id: state.lastResultId })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.mode === 'smtp') {
      status.className = 'email-action-box success';
      status.innerHTML = `
        <div class="email-action-title">✅ Result Successfully Sent</div>
        <div class="email-action-desc">Email delivered to <strong>${escapeHtml(to)}</strong> via the configured SMTP server.</div>
      `;
    } else {
      // SMTP not configured, or connection issue, or fallback needed
      const reason = data.error || data.message || 'SMTP email credentials are not configured on the server.';
      status.className = 'email-action-box';
      status.innerHTML = `
        <div class="email-action-title">ℹ️ ${escapeHtml(reason)}</div>
        <div class="email-action-desc">You can send this report to <strong>${escapeHtml(to)}</strong> right now via Gmail or your mail app, or configure SMTP credentials:</div>
        <div class="email-action-btns">
          <a href="${gmailUrl}" target="_blank" rel="noopener noreferrer" class="btn action-btn">✉️ Send via Gmail</a>
          <a href="${mailtoUrl}" class="btn secondary">📨 Open in Mail App</a>
          <button type="button" class="btn ghost" id="btn-copy-email-report">📋 Copy Report Text</button>
          <button type="button" class="btn secondary" id="btn-open-smtp-config">⚙️ Configure SMTP</button>
        </div>
      `;

      document.getElementById('btn-copy-email-report')?.addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
          const original = e.target.textContent;
          e.target.textContent = '✅ Copied!';
          setTimeout(() => { e.target.textContent = original; }, 2500);
        } catch (_) {
          showError('Unable to copy to clipboard.');
        }
      });

      document.getElementById('btn-open-smtp-config')?.addEventListener('click', () => {
        openSmtpModal();
      });
    }
  } catch (err) {
    status.className = 'email-action-box';
    status.innerHTML = `
      <div class="email-action-title">ℹ️ Direct SMTP dispatch unavailable</div>
      <div class="email-action-desc">You can send this report to <strong>${escapeHtml(to)}</strong> right now:</div>
      <div class="email-action-btns">
        <a href="${gmailUrl}" target="_blank" rel="noopener noreferrer" class="btn action-btn">✉️ Send via Gmail</a>
        <a href="${mailtoUrl}" class="btn secondary">📨 Open in Mail App</a>
        <button type="button" class="btn secondary" id="btn-open-smtp-config">⚙️ Configure SMTP</button>
      </div>
    `;
    document.getElementById('btn-open-smtp-config')?.addEventListener('click', openSmtpModal);
  }
});

// ---------------------------------------------------------------------------
// SMTP Settings Modal Handlers
// ---------------------------------------------------------------------------
async function openSmtpModal() {
  const modal = document.getElementById('smtp-modal');
  const feedback = document.getElementById('smtp-modal-feedback');
  feedback.className = 'note hidden';
  feedback.textContent = '';
  modal.classList.remove('hidden');

  try {
    const res = await fetch('/api/email/status');
    const data = await res.json();
    if (data.host) document.getElementById('smtp-host').value = data.host;
    if (data.port) document.getElementById('smtp-port').value = data.port;
    if (data.user) document.getElementById('smtp-user').value = data.user;
    if (data.from_email) document.getElementById('smtp-from').value = data.from_email;
    if (data.has_password) {
      document.getElementById('smtp-pass').placeholder = '•••••••• (saved)';
    }
  } catch (_) {}
}

document.getElementById('smtp-settings-btn')?.addEventListener('click', openSmtpModal);
document.getElementById('smtp-close-btn')?.addEventListener('click', () => {
  document.getElementById('smtp-modal').classList.add('hidden');
});
document.getElementById('smtp-cancel-btn')?.addEventListener('click', () => {
  document.getElementById('smtp-modal').classList.add('hidden');
});

// Save SMTP Config
document.getElementById('smtp-save-btn')?.addEventListener('click', async () => {
  const host = document.getElementById('smtp-host').value.trim();
  const port = parseInt(document.getElementById('smtp-port').value, 10) || 587;
  const user = document.getElementById('smtp-user').value.trim();
  const password = document.getElementById('smtp-pass').value.trim();
  const from_email = document.getElementById('smtp-from').value.trim();
  const feedback = document.getElementById('smtp-modal-feedback');

  if (!host || !user) {
    feedback.className = 'note warn';
    feedback.textContent = 'Please provide at least the SMTP host and username.';
    feedback.classList.remove('hidden');
    return;
  }

  feedback.className = 'note';
  feedback.textContent = 'Saving configuration...';
  feedback.classList.remove('hidden');

  try {
    const res = await fetch('/api/email/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, user, password, from_email })
    });
    const data = await res.json();
    if (data.success) {
      feedback.className = 'note success';
      feedback.textContent = '✅ SMTP configuration saved! Future emails will dispatch automatically.';
      setTimeout(() => {
        document.getElementById('smtp-modal').classList.add('hidden');
      }, 1800);
    } else {
      feedback.className = 'note warn';
      feedback.textContent = data.error || 'Failed to save configuration.';
    }
  } catch (err) {
    feedback.className = 'note warn';
    feedback.textContent = 'Server error while saving configuration.';
  }
});

// Test SMTP Connection
document.getElementById('smtp-test-btn')?.addEventListener('click', async () => {
  const host = document.getElementById('smtp-host').value.trim();
  const port = parseInt(document.getElementById('smtp-port').value, 10) || 587;
  const user = document.getElementById('smtp-user').value.trim();
  const password = document.getElementById('smtp-pass').value.trim();
  const feedback = document.getElementById('smtp-modal-feedback');

  if (!host || !user) {
    feedback.className = 'note warn';
    feedback.textContent = 'Please enter Host and Username to test connection.';
    feedback.classList.remove('hidden');
    return;
  }

  feedback.className = 'note';
  feedback.textContent = 'Testing connection and authentication...';
  feedback.classList.remove('hidden');

  try {
    const res = await fetch('/api/email/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, user, password })
    });
    const data = await res.json();
    if (data.success) {
      feedback.className = 'note success';
      feedback.textContent = '✅ SMTP connection and authentication successful!';
    } else {
      feedback.className = 'note warn';
      feedback.textContent = `❌ ${data.error || 'Connection failed'}`;
    }
  } catch (err) {
    feedback.className = 'note warn';
    feedback.textContent = 'Connection test failed. Check network or server.';
  }
});

async function loadHistory() {
  try {
    const res = await fetch('/api/results');
    const rows = await res.json();
    const tbody = document.querySelector('#history-table tbody');
    if (!tbody) return;
    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-dim); padding:16px;">No recent measurement history.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.created_at}</td>
        <td>${(r.analyte || '').replace(/_/g, ' ')}</td>
        <td class="mono">${r.intensity ? r.intensity.toFixed(2) + ' a.u.' : '—'}</td>
        <td class="mono" style="font-weight:600;color:var(--glow)">${r.concentration.toFixed(3)} ${r.units}</td>
      </tr>
    `).join('');
  } catch (err) {
    // Silent fail for history
  }
}

document.getElementById('btn-clear-history')?.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear all measurement history?')) return;
  try {
    const res = await fetch('/api/results', { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      loadHistory();
    }
  } catch (_) {
    showError('Failed to clear history.');
  }
});

// Window resize listener to re-render responsive graphs
window.addEventListener('resize', () => {
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (activeTab === 'calibrate') {
    const curve = state.library.find(c => c.analyte === document.getElementById('analyte-lib').value);
    if (curve) loadCalibrationInto(curve);
  } else if (activeTab === 'results' && state.lastPrediction) {
    renderResultGraph(state.lastPrediction);
  } else if (activeTab === 'acquire' && state.imageObj) {
    renderDisplayCanvas();
  }
});

// Initialize on page load
loadLibrary();
