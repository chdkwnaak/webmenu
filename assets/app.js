'use strict';

const APP_VERSION = '2.0.0';
const BUILD_DATE = '2026-11-24';
const SETTINGS_KEY = 'coordinate-settings-v2';
const CUSTOM = 'CUSTOM_PROJ4';
const $ = (id) => document.getElementById(id);
const state = {
  file: null, rows: [], pending: null, completed: null, controller: null,
  running: false, loading: false, loadToken: 0, page: 0, map: null, marker: null,
  mapPoints: [], activePoint: 0, onlineMap: false, tileLayer: null,
  editor: null, text: '', editorLocked: false, headerPreference: null,
};
const crsMap = new Map(CRS_LIST.map((crs) => [crs.id, crs]));
const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
const clean = (value) => String(value ?? '').trim();
const escapeCsv = (value) => /[",\r\n]/.test(String(value ?? ''))
  ? '"' + String(value ?? '').replace(/"/g, '""') + '"' : String(value ?? '');
const formatNumber = (number, digits) => {
  const result = number.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return result === '-0' ? '0' : result;
};

function log(message) {
  const output = $('conversionLog');
  const lines = output.textContent.split('\n').filter(Boolean);
  lines.push(new Date().toLocaleTimeString('ko-KR') + '  ' + message);
  output.textContent = lines.slice(-250).join('\n');
  output.scrollTop = output.scrollHeight;
}

function notify(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'cc-toast ' + type;
  toast.role = 'status';
  toast.textContent = message;
  $('toastContainer').append(toast);
  setTimeout(() => toast.remove(), 5500);
}

function setEditorText(text, locked = state.editorLocked) {
  state.text = text;
  state.editorLocked = locked;
  const frame = $('inputText');
  frame.hidden = locked;
  $('fileDataPreview').hidden = !locked;
  if (locked) $('fileDataPreview').textContent = text;
  if (!locked && frame.contentWindow?.setEditorText) {
    frame.contentWindow.setEditorText(text);
    state.editor = frame.contentWindow;
  }
  frame.inert = locked;
  frame.tabIndex = locked ? -1 : 0;
  frame.style.pointerEvents = locked ? 'none' : '';
  if (locked && document.activeElement === frame) frame.blur();
}

function getEditorText() {
  return $('inputText').contentWindow?.getEditorText?.() ?? state.text;
}

function setTheme(theme, persist = true) {
  const dark = theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  $('inputText').contentDocument?.documentElement?.classList.toggle('dark', dark);
  $('themeLabel').textContent = dark ? '라이트 모드' : '다크 모드';
  $('themeToggleBtn').setAttribute('aria-pressed', String(dark));
  if (persist) saveSettings();
}

function settingsSnapshot() {
  return {
    version: APP_VERSION, source: $('sourceCrs').value, target: $('targetCrs').value,
    sourceProj: $('sourceCustomProj').value, targetProj: $('targetCustomProj').value,
    singleSwap: $('singleSwapAxis').checked, bulkSwap: $('swapInputAxis').checked,
    header: state.headerPreference, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  };
}

function applySettings(settings) {
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('설정 파일 형식이 올바르지 않습니다.');
  for (const [key, id] of [['source', 'sourceCrs'], ['target', 'targetCrs']]) {
    if (crsMap.has(settings[key]) || settings[key] === CUSTOM) $(id).value = settings[key];
  }
  for (const [key, id] of [['sourceProj', 'sourceCustomProj'], ['targetProj', 'targetCustomProj']]) {
    if (typeof settings[key] === 'string') $(id).value = settings[key];
  }
  for (const [key, id] of [['singleSwap', 'singleSwapAxis'], ['bulkSwap', 'swapInputAxis']]) {
    if (typeof settings[key] === 'boolean') $(id).checked = settings[key];
  }
  if (typeof settings.header === 'boolean') state.headerPreference = settings.header;
  if (settings.theme === 'dark' || settings.theme === 'light') setTheme(settings.theme, false);
  updateCustomPanel();
  updateAxisLabels();
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsSnapshot())); }
  catch { log('브라우저 설정 저장이 제한되어 있습니다. 설정 내보내기를 사용하세요.'); }
}

function updateCustomPanel() {
  const source = $('sourceCrs').value === CUSTOM;
  const target = $('targetCrs').value === CUSTOM;
  $('customProjPanel').classList.toggle('hidden', !(source || target));
  $('customProjPanel').classList.toggle('grid', source || target);
  for (const [id, show] of [['sourceCustomProjField', source], ['targetCustomProjField', target]]) {
    $(id).classList.toggle('hidden', !show);
    $(id).classList.toggle('flex', show);
  }
}

function updateAxisLabels() {
  for (const [toggle, first, second] of [
    ['swapInputAxis', 'firstColumnLabel', 'secondColumnLabel'],
    ['singleSwapAxis', 'singleFirstLabel', 'singleSecondLabel'],
  ]) {
    const swapped = $(toggle).checked;
    $(first).textContent = '1번째 값 (' + (swapped ? '위도/Northing' : '경도/Easting') + ')';
    $(second).textContent = '2번째 값 (' + (swapped ? '경도/Easting' : '위도/Northing') + ')';
  }
}

function getCrs(role) {
  const value = $(role + 'Crs').value;
  if (value !== CUSTOM) return { ...crsMap.get(value) };
  const definition = $(role + 'CustomProj').value.trim().replace(/\s+/g, ' ');
  if (!definition) throw new Error('사용자 지정 Proj4 정의를 입력해주세요.');
  const id = role === 'source' ? 'CUSTOM_SOURCE_PROJ4' : 'CUSTOM_TARGET_PROJ4';
  try { proj4.defs(id, definition); proj4(id); }
  catch { throw new Error('사용자 지정 Proj4 정의가 올바르지 않습니다.'); }
  return { id, label: '사용자 지정 ' + (role === 'source' ? '원본' : '대상'),
    proj: definition, type: /\+proj=(longlat|latlong|lonlat)\b/i.test(definition) ? 'dd' : 'projected' };
}

function parseNumeric(value) {
  const text = clean(value);
  if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    throw new Error('올바르지 않은 숫자 형식: ' + text);
  }
  const result = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(result)) throw new Error('유효하지 않은 숫자입니다.');
  return result;
}

function parseNumericPair(line) {
  const text = clean(line);
  let parts = text.split(/\s+/);
  if (parts.length !== 2 || parts.some((part) => /,$/.test(part))) {
    parts = text.split(',').map(clean);
  }
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error('좌표 값이 정확히 두 개 필요합니다.');
  return parts.map(parseNumeric);
}

function parseDmsValue(value, axis) {
  let text = clean(value).replace(/[′’]/g, "'").replace(/[″“”]/g, '"');
  const directions = text.match(/[NSEW동서남북]/gi) || [];
  const direction = directions[0]?.toUpperCase() || '';
  if (directions.length > 1) throw new Error('방향 표기는 한 번만 입력해주세요.');
  text = text.replace(/[NSEW동서남북]/gi, '').replace(/[°도'분"초]/g, ' ').trim();
  const parts = text.split(/\s+/);
  if (!parts.length || parts.length > 3 || !parts.every((part) => /^[+-]?\d+(?:\.\d+)?$/.test(part))) {
    throw new Error('DMS 형식이 올바르지 않습니다.');
  }
  const [degrees, minutes = 0, seconds = 0] = parts.map(Number);
  if (![degrees, minutes, seconds].every(Number.isFinite)) throw new Error('유효하지 않은 DMS 값입니다.');
  if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) throw new Error('DMS 분·초는 0 이상 60 미만이어야 합니다.');
  if (parts.length > 1 && !Number.isInteger(degrees)) throw new Error('분·초를 입력할 때 도 값은 정수여야 합니다.');
  if (parts.length > 2 && !Number.isInteger(minutes)) throw new Error('초를 입력할 때 분 값은 정수여야 합니다.');
  if (axis === 'lon' && /[NS남북]/.test(direction)) throw new Error('경도에는 E/W(동/서)를 사용하세요.');
  if (axis === 'lat' && /[EW동서]/.test(direction)) throw new Error('위도에는 N/S(북/남)를 사용하세요.');
  if ((degrees < 0 || /^-/.test(parts[0])) && /[NE북동]/.test(direction)) throw new Error('음수 부호와 동/북 방향이 충돌합니다.');
  let decimal = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  if (/^-/.test(parts[0]) || /[SW남서]/.test(direction)) decimal *= -1;
  if (Math.abs(decimal) > (axis === 'lon' ? 180 : 90)) throw new Error('DMS 경위도 범위를 벗어났습니다.');
  return decimal;
}

function parseDmsPair(line, swap) {
  let parts = line.split(/\t|,/);
  if (parts.length === 1) {
    const matches = line.match(/[NSEW동서남북]?\s*[+-]?\d+(?:\.\d+)?[°도\s]+\d+(?:\.\d+)?['′분\s]+\d+(?:\.\d+)?["″초]?\s*[NSEW동서남북]?/gi);
    if (matches?.length === 2 && line.replace(matches[0], '').replace(matches[1], '').trim() === '') parts = matches;
    else {
      const values = line.trim().split(/\s+/);
      if (values.length === 2) parts = values;
      else if (values.length === 6) parts = [values.slice(0, 3).join(' '), values.slice(3).join(' ')];
    }
  }
  if (parts.length !== 2) throw new Error('DMS 좌표는 두 값을 탭이나 쉼표로 구분하세요.');
  return [parseDmsValue(parts[0], swap ? 'lat' : 'lon'), parseDmsValue(parts[1], swap ? 'lon' : 'lat')];
}

function validateGeographic(pair, crs) {
  if (crs.type === 'dd' || crs.type === 'dms') {
    if (Math.abs(pair[0]) > 180 || Math.abs(pair[1]) > 90) throw new Error('경도(-180~180) 또는 위도(-90~90) 범위를 벗어났습니다.');
  }
}

function toDms(value, axis) {
  let units = Math.round(Math.abs(value) * 3600000);
  const degrees = Math.floor(units / 3600000);
  units -= degrees * 3600000;
  const minutes = Math.floor(units / 60000);
  const seconds = (units - minutes * 60000) / 1000;
  const direction = axis === 'lon' ? (value < 0 ? 'W' : 'E') : (value < 0 ? 'S' : 'N');
  return degrees + '°' + String(minutes).padStart(2, '0') + "'" + seconds.toFixed(3) + '"' + direction;
}

function createContext(source, target, swap) {
  return { source, target, swap, transformer: proj4(source.proj, target.proj) };
}

function convertRecord(record, context) {
  try {
    const { source, target, swap, transformer } = context;
    let pair;
    if (record.values) {
      if (record.values.some((value) => !clean(value))) return { x: '', y: '', status: '좌표 누락', error: '한쪽 또는 양쪽 좌표가 비어 있습니다.' };
      pair = source.type === 'dms'
        ? record.values.map((value, i) => parseDmsValue(value, (i === 0) !== swap ? 'lon' : 'lat'))
        : record.values.map(parseNumeric);
    } else pair = source.type === 'dms' ? parseDmsPair(record.line, swap) : parseNumericPair(record.line);
    if (swap) pair.reverse();
    validateGeographic(pair, source);
    const output = transformer.forward(pair);
    if (!output || !output.slice(0, 2).every(Number.isFinite)) throw new Error('변환 결과가 유효한 숫자가 아닙니다.');
    validateGeographic(output, target);
    const x = target.type === 'dms' ? toDms(output[0], 'lon') : formatNumber(output[0], target.type === 'dd' ? 8 : 3);
    const y = target.type === 'dms' ? toDms(output[1], 'lat') : formatNumber(output[1], target.type === 'dd' ? 8 : 3);
    return { x, y, status: '성공', error: '', coordinate: output };
  } catch (error) { return { x: '', y: '', status: '변환 실패', error: error.message }; }
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [], cell = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; afterQuote = true; }
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === '' && !afterQuote) { quoted = true; continue; }
    if (char === delimiter) { row.push(cell); cell = ''; afterQuote = false; continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = ''; afterQuote = false; continue;
    }
    if (afterQuote && !/\s/.test(char)) throw new Error('CSV 닫는 따옴표 뒤에 잘못된 문자가 있습니다.');
    if (!afterQuote) cell += char;
  }
  if (quoted) throw new Error('CSV 따옴표가 닫히지 않았습니다.');
  if (cell || row.length || (text.length && !/[\r\n]$/.test(text))) { row.push(cell); rows.push(row); }
  return rows;
}

function detectDelimiter(text) {
  let quoted = false, first = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    }
    if (!quoted && /[\r\n]/.test(char)) break;
    if (!quoted) first += char;
  }
  const counts = [',', '\t', ';'].map((char) => [char, first.split(char).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : null;
}

async function readFileRows(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  const buffer = await file.arrayBuffer();
  if (['xlsx', 'xls'].includes(extension)) {
    const workbook = XLSX.read(buffer, { type: 'array' });
    if (!workbook.SheetNames.length) throw new Error('엑셀 파일에 시트가 없습니다.');
    return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1, raw: true, defval: '', blankrows: true,
    });
  }
  if (!['csv', 'txt'].includes(extension)) throw new Error('csv, txt, xlsx, xls 파일을 선택하세요.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { text = new TextDecoder('euc-kr').decode(buffer); }
  text = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  if (delimiter) return parseDelimited(text, delimiter);
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.trim() ? line.trim().split(/\s+/) : ['']);
}

function headerIndexes(row) {
  const normalized = row.map((value) => clean(value).toLowerCase().replace(/[\s_()[\]{}\/-]/g, ''));
  const x = normalized.findIndex((value) => ['x', '경도', 'longitude', 'lon', 'lng', 'easting', 'east', 'x좌표'].includes(value));
  const y = normalized.findIndex((value) => ['y', '위도', 'latitude', 'lat', 'northing', 'north', 'y좌표'].includes(value));
  return [x, y];
}

async function handleFile(file) {
  if (state.running) return;
  const token = ++state.loadToken;
  state.loading = true;
  updateButtons();
  try {
    const rows = await readFileRows(file);
    if (token !== state.loadToken) return;
    if (!rows.length || !rows.some((row) => row.length >= 2)) throw new Error('두 개 이상의 열과 데이터 행이 필요합니다.');
    state.file = { name: file.name };
    state.rows = rows;
    const indexes = headerIndexes(rows[0]);
    const explicitHeader = indexes.every((index) => index >= 0);
    let numeric = 0;
    for (const value of rows[0]) { try { parseNumeric(value); numeric++; } catch {} }
    $('firstRowHeaderToggle').checked = state.headerPreference ?? (explicitHeader || numeric < 2);
    $('fileName').textContent = file.name;
    $('inputModeLabel').textContent = '파일 모드 · 원본 열/행 보존';
    $('mappingPanel').classList.remove('hidden');
    renderMapping(false);
    state.completed = null;
    renderResults();
    resetMap();
    log('파일 로드: ' + file.name + ' (' + (rows.length - Number($('firstRowHeaderToggle').checked)) + '개 데이터 행)');
  } catch (error) {
    log('파일 로드 실패: ' + error.message);
    notify(error.message, 'error');
  } finally {
    if (token === state.loadToken) { state.loading = false; updateButtons(); }
    $('fileInput').value = '';
  }
}

function renderMapping(preserve) {
  if (!state.rows.length) return;
  const count = state.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = $('firstRowHeaderToggle').checked;
  let indexes = header ? headerIndexes(state.rows[0]) : [-1, -1];
  if (indexes.some((index) => index < 0)) {
    const sample = state.rows.slice(Number(header)).find((row) => row.some((value) => clean(value))) || [];
    const numeric = [];
    sample.forEach((value, index) => { try { parseNumeric(value); numeric.push(index); } catch {} });
    indexes = numeric.length >= 2 ? numeric.slice(0, 2) : [0, 1];
  }
  if ($('swapInputAxis').checked) indexes.reverse();
  for (const [i, id] of ['xColumnSelect', 'yColumnSelect'].entries()) {
    const select = $(id), previous = select.value;
    select.replaceChildren(...Array.from({ length: count }, (_, index) => {
      const label = header ? clean(state.rows[0][index]) : '';
      return new Option((index + 1) + '열' + (label ? ' (' + label + ')' : ''), String(index));
    }));
    select.value = preserve && previous !== '' && Number(previous) < count ? previous : String(indexes[i]);
  }
  fillFilePreview();
}

function fillFilePreview() {
  if (!state.file) return;
  const start = Number($('firstRowHeaderToggle').checked);
  const first = Number($('xColumnSelect').value), second = Number($('yColumnSelect').value);
  const rows = state.rows.slice(start);
  $('inputDataLabel').textContent = '파일 미리보기: ' + rows.length + '행 · 원본행 / 1번째 / 2번째 (최대 100행, 읽기 전용)';
  setEditorText(rows.slice(0, 100).map((row, index) =>
    (index + start + 1) + '행\t' + (clean(row[first]) || '(빈 값)') + '\t' + (clean(row[second]) || '(빈 값)')
  ).join('\n'), true);
}

function directInput() {
  if (state.running) return;
  state.loadToken++;
  state.loading = false;
  state.file = null; state.rows = [];
  $('fileName').textContent = '';
  $('inputModeLabel').textContent = '직접 입력 모드';
  $('inputDataLabel').textContent = '대량 좌표 입력 · 한 줄에 두 좌표';
  $('mappingPanel').classList.add('hidden');
  setEditorText('', false);
  updateButtons();
}

function prepareBatch() {
  const source = getCrs('source'), target = getCrs('target');
  const swap = $('swapInputAxis').checked;
  const context = createContext(source, target, swap);
  let headers, records, fileName;
  if (state.file) {
    const first = Number($('xColumnSelect').value), second = Number($('yColumnSelect').value);
    if (first === second) throw new Error('서로 다른 두 좌표 열을 선택하세요.');
    const start = Number($('firstRowHeaderToggle').checked);
    const count = state.rows.reduce((max, row) => Math.max(max, row.length), 0);
    headers = Array.from({ length: count }, (_, index) =>
      start ? String(state.rows[0][index] ?? '') : '열' + (index + 1));
    records = state.rows.slice(start).map((row, index) => ({
      row: index + start + 1,
      cells: Array.from({ length: count }, (_, col) => row[col] ?? ''),
      values: [row[first] ?? '', row[second] ?? ''],
    }));
    fileName = state.file.name.replace(/\.[^.]+$/, '');
  } else {
    headers = ['원본입력'];
    records = getEditorText().split(/\r?\n/).flatMap((line, index) =>
      line.trim() ? [{ row: index + 1, cells: [line], line: line.trim() }] : []);
    fileName = '직접입력';
  }
  if (!records.length) throw new Error('변환할 데이터가 없습니다.');
  const outputHeaders = [...headers];
  for (const desired of ['원본행', '변환X', '변환Y', '처리상태', '오류내용']) {
    let name = desired, suffix = 2;
    while (outputHeaders.includes(name)) name = desired + '_' + suffix++;
    outputHeaders.push(name);
  }
  return { context, records, headers: outputHeaders, fileName };
}

function populateTable(table, headers, rows, statusIndex = -1) {
  table.replaceChildren();
  const head = document.createElement('thead'), heading = document.createElement('tr');
  for (const text of headers) {
    const cell = document.createElement('th');
    cell.scope = 'col'; cell.textContent = text; heading.append(cell);
  }
  head.append(heading); table.append(head);
  const body = document.createElement('tbody');
  for (const values of rows) {
    const row = document.createElement('tr');
    for (const [index, value] of values.entries()) {
      const cell = document.createElement('td');
      cell.textContent = String(value ?? '');
      if (index === statusIndex && value !== '성공') cell.className = 'cc-error';
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
}

function showPreview(allowStart) {
  if (state.running || state.loading) return;
  try {
    const batch = prepareBatch();
    state.pending = batch;
    const { source, target, swap } = batch.context;
    $('previewContext').textContent =
      '원본: ' + source.label + '\n대상: ' + target.label +
      '\n입력: ' + (swap ? '위도/Northing → 경도/Easting' : '경도/Easting → 위도/Northing') +
      '\n총 ' + batch.records.length + '행 · 출력은 항상 경도/Easting, 위도/Northing 순서입니다.';
    populateTable($('conversionPreviewTable'), ['원본행', '원본 좌표', '변환X', '변환Y', '처리상태', '오류내용'],
      batch.records.slice(0, 5).map((record) => {
        const result = convertRecord(record, batch.context);
        return [record.row, record.values ? record.values.join(' / ') : record.line,
          result.x, result.y, result.status, result.error];
      }), 4);
    $('confirmConversionBtn').hidden = !allowStart;
    $('conversionPreview').showModal();
  } catch (error) { notify(error.message, 'error'); }
}

function updateButtons() {
  for (const id of [
    'sourceCrs', 'targetCrs', 'sourceCustomProj', 'targetCustomProj', 'singleXInput', 'singleYInput',
    'singleConvertBtn', 'singleSwapAxis', 'swapInputAxis', 'xColumnSelect', 'yColumnSelect',
    'firstRowHeaderToggle', 'previewBtn', 'convertBtn', 'directInputBtn', 'fileInput',
    'importSettingsBtn', 'resetBtn',
  ]) $(id).disabled = state.running || state.loading;
  $('dropZone').setAttribute('aria-disabled', String(state.running || state.loading));
  $('dropZone').tabIndex = state.running || state.loading ? -1 : 0;
  $('cancelBtn').classList.toggle('hidden', !state.running);
  $('cancelBtn').disabled = Boolean(state.controller?.signal.aborted);
  $('csvBtn').disabled = state.running || !state.completed;
  $('copyBtn').disabled = state.running || !state.completed;
  const frame = $('inputText');
  frame.inert = state.running || state.editorLocked;
  frame.style.pointerEvents = frame.inert ? 'none' : '';
}

async function runConversion(batch) {
  if (state.running) return;
  state.running = true;
  state.controller = new AbortController();
  updateButtons();
  saveSettings();
  const results = [], tableRows = [], total = batch.records.length;
  const completedBefore = state.completed;
  let lastPercent = -1;
  $('conversionProgress').value = 0;
  log('대량 변환 시작: ' + total + '행 · ' + batch.context.source.label + ' → ' + batch.context.target.label);
  log('입력 순서: ' + (batch.context.swap ? '위도/Northing → 경도/Easting' : '경도/Easting → 위도/Northing'));
  try {
    for (let start = 0; start < total; start += 250) {
      if (state.controller.signal.aborted) {
        $('progressLabel').textContent = '취소됨 · 부분 결과 저장 안 함';
        log('취소했습니다. 이번 부분 결과를 폐기하고 기존 완료 결과를 유지합니다.');
        state.completed = completedBefore;
        return;
      }
      for (let i = start; i < Math.min(start + 250, total); i++) {
        const record = batch.records[i], result = convertRecord(record, batch.context);
        results.push(result);
        tableRows.push([...record.cells, record.row, result.x, result.y, result.status, result.error]);
      }
      const current = results.length, percent = Math.floor(current * 100 / total);
      $('conversionProgress').value = percent;
      $('progressLabel').textContent = current.toLocaleString() + ' / ' + total.toLocaleString() + ' (' + percent + '%)';
      if (Math.floor(percent / 10) > lastPercent) { log('처리 중: ' + current + ' / ' + total + ' (' + percent + '%)'); lastPercent = Math.floor(percent / 10); }
      await delay();
    }
    if (state.controller.signal.aborted) {
      $('progressLabel').textContent = '취소됨 · 부분 결과 저장 안 함';
      log('취소했습니다. 이번 결과는 저장하지 않았습니다.');
      return;
    }
    const success = results.filter((result) => result.status === '성공').length;
    const missing = results.filter((result) => result.status === '좌표 누락').length;
    const summary = '총 ' + total + '행 · 성공 ' + success + ' · 좌표 누락 ' + missing + ' · 변환 실패 ' + (total - success - missing);
    state.completed = { headers: batch.headers, rows: tableRows, results, fileName: batch.fileName,
      summary, context: batch.context };
    state.page = 0;
    renderResults();
    updateMap(results, batch.context.target);
    $('progressLabel').textContent = '변환 완료 (100%) · CSV 저장 가능';
    log(summary);
    notify(summary, success === total ? 'success' : 'warning');
  } catch (error) {
    state.completed = completedBefore;
    $('progressLabel').textContent = '오류 발생';
    log('변환 오류: ' + error.message); notify(error.message, 'error');
  } finally {
    state.running = false; state.controller = null; updateButtons();
  }
}

function renderResults() {
  const result = state.completed;
  if (!result) {
    $('resultTable').replaceChildren();
    $('outputText').value = '';
    $('resultSummary').textContent = '아직 완료된 결과가 없습니다.';
    $('resultPageInfo').textContent = '';
    $('resultPager').hidden = true;
    updateButtons();
    return;
  }
  const maxPage = Math.max(0, Math.ceil(result.rows.length / 100) - 1);
  state.page = Math.max(0, Math.min(state.page, maxPage));
  const start = state.page * 100;
  populateTable($('resultTable'), result.headers, result.rows.slice(start, start + 100), result.headers.length - 2);
  $('resultSummary').textContent = result.summary;
  $('outputText').value = result.results.filter((row) => row.status === '성공').map((row) => row.x + ' ' + row.y).join('\n');
  $('resultPageInfo').textContent = result.rows.length + '행 중 ' + (start + 1) + '–' + Math.min(start + 100, result.rows.length) + '행 표시 · CSV에는 전체 행이 저장됩니다.';
  $('resultPager').hidden = result.rows.length <= 100;
  $('previousPageBtn').disabled = state.page === 0;
  $('nextPageBtn').disabled = state.page === maxPage;
  updateButtons();
}

function convertSingle() {
  try {
    if (!clean($('singleXInput').value) || !clean($('singleYInput').value)) throw new Error('단일 좌표 두 값을 모두 입력하세요.');
    const context = createContext(getCrs('source'), getCrs('target'), $('singleSwapAxis').checked);
    const record = { row: 1, cells: [$('singleXInput').value, $('singleYInput').value],
      values: [$('singleXInput').value, $('singleYInput').value] };
    const result = convertRecord(record, context);
    if (result.status !== '성공') throw new Error(result.error);
    $('singleResult').value = result.x + ' ' + result.y;
    state.completed = { headers: ['원본1', '원본2', '원본행', '변환X', '변환Y', '처리상태', '오류내용'],
      rows: [[...record.cells, 1, result.x, result.y, result.status, '']],
      results: [result], fileName: '단일입력', summary: '단일 변환 성공 · 1행', context };
    state.page = 0; renderResults(); updateMap([result], context.target);
    saveSettings(); log('단일 변환 성공: ' + result.x + ' ' + result.y);
  } catch (error) { notify(error.message, 'error'); }
}

function triggerDownload(blob, name) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadCsv() {
  if (!state.completed || state.running) return;
  const result = state.completed;
  const name = '변환결과_' + result.fileName + '.csv';
  let handle;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      handle = await window.showSaveFilePicker({
        id: 'coordinate-results-v2', suggestedName: name,
        types: [{ description: 'CSV 파일', accept: { 'text/csv': ['.csv'] } }],
      });
    } catch (error) {
      if (error.name === 'AbortError') { log('CSV 저장을 취소했습니다.'); return; }
      log('저장 위치 선택을 사용할 수 없어 일반 다운로드로 저장합니다.');
    }
  }
  const text = '\uFEFF' + [result.headers, ...result.rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  try {
    if (handle) {
      const writable = await handle.createWritable();
      try { await writable.write(blob); await writable.close(); }
      catch (error) { try { await writable.abort(); } catch {} throw error; }
      log('CSV 저장 완료: ' + handle.name);
    } else { triggerDownload(blob, name); log('CSV 다운로드 요청: ' + name + ' · 브라우저 다운로드 목록에서 확인하세요.'); }
  } catch (error) { log('CSV 저장 실패: ' + error.message); notify(error.message, 'error'); }
}

async function copyResult() {
  const text = $('outputText').value;
  if (!text) { notify('복사할 성공 좌표가 없습니다.', 'warning'); return; }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('fallback');
    notify('성공 좌표를 복사했습니다.', 'success');
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = text; document.body.append(temporary); temporary.select();
    const copied = document.execCommand('copy'); temporary.remove();
    notify(copied ? '성공 좌표를 복사했습니다.' : '텍스트 보기에서 좌표를 선택해 복사해주세요.', copied ? 'success' : 'warning');
  }
}

function resetMap() {
  state.mapPoints = [];
  $('mapPreviewPanel').classList.add('hidden');
  if (state.marker) { state.marker.remove(); state.marker = null; }
}

function updateMap(results, target) {
  const valid = results.filter((result) => result.coordinate && result.status === '성공');
  state.mapPoints = [valid[0], valid.at(-1)].map((result) => {
    try {
      if (!result) return null;
      const point = proj4(target.proj, crsMap.get('EPSG:4326').proj, result.coordinate);
      if (point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90) return point;
    } catch {}
    return null;
  });
  if (!state.mapPoints.some(Boolean)) { resetMap(); return; }
  $('mapPreviewPanel').classList.remove('hidden');
  $('mapLastBtn').disabled = valid.length < 2;
  state.activePoint = 0; renderMap();
}

function renderMap() {
  const point = state.mapPoints[state.activePoint];
  if (!point) return;
  const label = state.activePoint ? '마지막 좌표' : '첫 번째 좌표';
  $('mapCoordinateLabel').textContent = label + ' · 경도 ' + formatNumber(point[0], 8) + ', 위도 ' + formatNumber(point[1], 8);
  if (!state.map) state.map = L.map($('mapPreview'), { scrollWheelZoom: false }).setView([point[1], point[0]], 15);
  if (!state.marker) state.marker = L.marker([point[1], point[0]]).addTo(state.map);
  state.marker.setLatLng([point[1], point[0]]);
  const popup = document.createElement('span'); popup.textContent = $('mapCoordinateLabel').textContent;
  state.marker.bindPopup(popup);
  state.map.setView([point[1], point[0]], state.map.getZoom());
  state.map.invalidateSize();
  $('mapStatus').textContent = state.onlineMap
    ? '온라인 지도 배경을 사용 중입니다. 인터넷이 없으면 좌표 표시는 유지됩니다.'
    : '오프라인 좌표 미리보기 · 배경 지도는 온라인 지도 보기 버튼을 누르면 불러옵니다.';
}

function enableOnlineMap() {
  if (!state.map) return;
  if (state.tileLayer) return;
  state.onlineMap = true;
  state.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);
  state.tileLayer.on('tileerror', () => { $('mapStatus').textContent = '배경 지도를 불러오지 못했습니다. 좌표 변환과 표시는 계속 사용할 수 있습니다.'; });
  renderMap();
}

function bindEvents() {
  $('inputText').addEventListener('load', () => {
    setEditorText(state.text, state.editorLocked);
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light', false);
  });
  for (const id of ['sourceCrs', 'targetCrs', 'sourceCustomProj', 'targetCustomProj']) {
    $(id).addEventListener('change', () => { updateCustomPanel(); saveSettings(); });
  }
  for (const id of ['singleSwapAxis', 'swapInputAxis']) {
    $(id).addEventListener('change', () => { updateAxisLabels(); saveSettings(); });
  }
  $('firstRowHeaderToggle').addEventListener('change', () => {
    state.headerPreference = $('firstRowHeaderToggle').checked;
    renderMapping(false); saveSettings();
  });
  for (const id of ['xColumnSelect', 'yColumnSelect']) $(id).addEventListener('change', fillFilePreview);
  const openFile = () => { if (!state.running && !state.loading) $('fileInput').click(); };
  $('dropZone').addEventListener('click', (event) => { if (event.target !== $('fileInput')) openFile(); });
  $('dropZone').addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); openFile(); } });
  $('dropZone').addEventListener('dragover', (event) => event.preventDefault());
  $('dropZone').addEventListener('drop', (event) => { event.preventDefault(); if (event.dataTransfer.files[0] && !state.running) handleFile(event.dataTransfer.files[0]); });
  $('fileInput').addEventListener('change', () => { if ($('fileInput').files[0]) handleFile($('fileInput').files[0]); });
  $('directInputBtn').addEventListener('click', directInput);
  $('previewBtn').addEventListener('click', () => showPreview(false));
  $('convertBtn').addEventListener('click', () => showPreview(true));
  $('closePreviewBtn').addEventListener('click', () => $('conversionPreview').close());
  $('conversionPreview').addEventListener('close', () => { state.pending = null; });
  $('confirmConversionBtn').addEventListener('click', () => {
    const pending = state.pending;
    state.pending = null; $('conversionPreview').close();
    if (pending) runConversion(pending);
  });
  $('cancelBtn').addEventListener('click', () => { state.controller?.abort(); $('cancelBtn').disabled = true; });
  $('singleConvertBtn').addEventListener('click', convertSingle);
  for (const id of ['singleXInput', 'singleYInput']) $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') convertSingle(); });
  $('csvBtn').addEventListener('click', downloadCsv);
  $('copyBtn').addEventListener('click', copyResult);
  $('tableViewBtn').addEventListener('click', () => setView(true));
  $('textViewBtn').addEventListener('click', () => setView(false));
  $('previousPageBtn').addEventListener('click', () => { state.page--; renderResults(); });
  $('nextPageBtn').addEventListener('click', () => { state.page++; renderResults(); });
  $('themeToggleBtn').addEventListener('click', () => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'));
  $('helpBtn').addEventListener('click', () => { $('helpModal').classList.remove('hidden'); $('helpModal').classList.add('flex'); $('closeHelpBtn').focus(); });
  const closeHelp = () => { $('helpModal').classList.add('hidden'); $('helpModal').classList.remove('flex'); $('helpBtn').focus(); };
  $('closeHelpBtn').addEventListener('click', closeHelp);
  $('helpModal').addEventListener('click', (event) => { if (event.target === $('helpModal')) closeHelp(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('helpModal').classList.contains('hidden')) closeHelp(); });
  $('mapFirstBtn').addEventListener('click', () => { state.activePoint = 0; renderMap(); });
  $('mapLastBtn').addEventListener('click', () => { state.activePoint = 1; renderMap(); });
  $('onlineMapBtn').addEventListener('click', enableOnlineMap);
  $('exportSettingsBtn').addEventListener('click', () => {
    triggerDownload(new Blob([JSON.stringify(settingsSnapshot(), null, 2)], { type: 'application/json' }), '좌표변환기_설정.json');
  });
  $('importSettingsBtn').addEventListener('click', () => $('settingsFile').click());
  $('settingsFile').addEventListener('change', async () => {
    const file = $('settingsFile').files[0];
    if (!file || state.running) return;
    try {
      if (file.size > 100000) throw new Error('설정 파일이 너무 큽니다.');
      applySettings(JSON.parse(await file.text()));
      if (state.file) {
        if (state.headerPreference !== null) $('firstRowHeaderToggle').checked = state.headerPreference;
        renderMapping(false);
      }
      saveSettings(); notify('설정을 불러왔습니다.', 'success');
    } catch (error) { notify(error.message, 'error'); }
    $('settingsFile').value = '';
  });
  $('resetBtn').addEventListener('click', () => {
    if (state.running || !confirm('입력과 결과를 초기화할까요? 기억한 좌표계 설정은 유지됩니다.')) return;
    directInput(); state.completed = null; state.pending = null;
    $('singleXInput').value = ''; $('singleYInput').value = ''; $('singleResult').value = '';
    state.page = 0; renderResults(); resetMap();
    $('conversionProgress').value = 0; $('progressLabel').textContent = '대기'; log('입력과 결과를 초기화했습니다.');
  });
  window.addEventListener('pagehide', saveSettings);
  window.addEventListener('beforeunload', (event) => { if (state.running) { event.preventDefault(); event.returnValue = ''; } });
}

function setView(table) {
  $('resultTableView').hidden = !table; $('resultTextView').hidden = table;
  $('tableViewBtn').setAttribute('aria-pressed', String(table));
  $('textViewBtn').setAttribute('aria-pressed', String(!table));
}

function init() {
  if (!window.proj4 || !window.XLSX || !window.L) {
    log('필수 라이브러리가 없습니다. HTML과 assets 폴더를 함께 보관해주세요.');
    notify('assets 폴더를 확인해주세요.', 'error');
    return;
  }
  for (const crs of CRS_LIST) proj4.defs(crs.id, crs.proj);
  for (const id of ['sourceCrs', 'targetCrs']) {
    $(id).replaceChildren(...CRS_LIST.map((crs) => new Option(crs.label, crs.id)), new Option('사용자 지정 Proj4 직접 입력', CUSTOM));
  }
  $('sourceCrs').value = 'EPSG:4326'; $('targetCrs').value = 'EPSG:5186';
  bindEvents(); updateCustomPanel(); updateAxisLabels();
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) applySettings(JSON.parse(stored));
    else setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light', false);
  } catch { log('설정을 복원할 수 없습니다. 기본 설정으로 실행합니다.'); }
  renderResults();
  log('GPS 좌표 변환기 v' + APP_VERSION + ' · 빌드 ' + BUILD_DATE + ' · 오프라인 준비 완료');
}

window.CoordinateConverter = { state, parseNumericPair, parseDmsValue, parseDmsPair, parseDelimited,
  prepareBatch, createContext, convertRecord, runConversion, readFileRows, settingsSnapshot };
init();
