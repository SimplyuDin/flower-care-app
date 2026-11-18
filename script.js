const STORAGE_KEY = 'plants';
const NOTIFY_DATE_KEY = 'lastNotifyDate';
const FIREBASE_URL = 'https://home-garden-dedec-default-rtdb.firebaseio.com';

const PLANT_TEMPLATES = {
  succulent: {
    label: 'Суккулент / кактус',
    summer: { water: 12, fertilize: 30 },
    winter: { water: 25, fertilize: 90 },
    tip: 'Главное — не перелить, дать земле полностью просохнуть между поливами.',
  },
  tropical: {
    label: 'Тропическое лиственное',
    summer: { water: 7, fertilize: 21 },
    winter: { water: 14, fertilize: 60 },
    tip: 'Избегать прямого палящего солнца.',
  },
  flowering: {
    label: 'Цветущее',
    summer: { water: 6, fertilize: 14 },
    winter: { water: 12, fertilize: 30 },
    tip: 'Следить за влажностью воздуха.',
  },
  fern: {
    label: 'Папоротник / влаголюбивое',
    summer: { water: 4, fertilize: 21 },
    winter: { water: 8, fertilize: 45 },
    tip: 'Любит высокую влажность воздуха — можно опрыскивать.',
  },
};

let pendingCheckin = null; // { id, type: 'water' | 'fertilize' }
let editingPlantId = null;

function generateTemplateNote(type, season) {
  const t = PLANT_TEMPLATES[type];
  if (!t) return '';
  return `${t.label}. Летом поливать раз в ~${t.summer.water} дн., зимой — раз в ~${t.winter.water} дн. ${t.tip}`;
}

function getCurrentSeason() {
  const month = new Date().getMonth(); // 0 = январь
  // упрощённо: март-октябрь — период активного роста, ноябрь-февраль — покой
  return (month >= 2 && month <= 9) ? 'summer' : 'winter';
}

function toDatetimeLocalValue(isoString) {
  const d = new Date(isoString);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function suggestedWaterMl(potSizeCm) {
  const size = Number(potSizeCm);
  if (!size || size <= 0) return null;
  return Math.round(size * size);
}

function formatDuration(ms) {
  if (ms <= 0) return 'сейчас';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} дн ${hours} ч ${minutes} мин`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function formatCountdown(ms) {
  return ms <= 0 ? 'Пора поливать! 💧' : `⏳ ${formatDuration(ms)} до полива`;
}

function getNextCareEvent(plant) {
  const waterMs = new Date(plant.lastWatered).getTime() + plant.waterFreq * 86400000 - Date.now();
  const fertilizeMs = new Date(plant.lastFertilized).getTime() + plant.fertilizeFreq * 86400000 - Date.now();
  return waterMs <= fertilizeMs
    ? { type: 'water', remainingMs: waterMs }
    : { type: 'fertilize', remainingMs: fertilizeMs };
}

function resizeImageFile(file, maxDim = 500) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadPlants() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

function savePlants(plants) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plants));
  syncToCloud(plants);
}

function syncToCloud(plants) {
  fetch(`${FIREBASE_URL}/plants.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plants),
  }).catch(() => {
    // нет интернета или Firebase недоступен — просто продолжаем работать локально
  });
}

function daysSince(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function daysUntilNextWater(plant) {
  return plant.waterFreq - daysSince(plant.lastWatered);
}

function daysUntilNextFertilize(plant) {
  return plant.fertilizeFreq - daysSince(plant.lastFertilized);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Check-in modal ----------

function openCheckin(id, type) {
  pendingCheckin = { id, type };
  const plant = loadPlants().find(p => p.id === id);
  document.getElementById('checkin-title').textContent =
    type === 'water' ? 'Подтверди полив' : 'Подтверди подкормку';

  const amountField = document.getElementById('checkin-amount');
  amountField.style.display = type === 'water' ? '' : 'none';
  const suggestion = type === 'water' ? suggestedWaterMl(plant.potSize) : null;
  amountField.placeholder = suggestion ? `рекомендуется ~${suggestion} мл` : 'например 200';
  amountField.value = '';

  document.getElementById('checkin-note').value = '';
  document.getElementById('checkin-state').value = 'ок';
  document.getElementById('checkin-modal').classList.remove('hidden');
}

function closeCheckin() {
  pendingCheckin = null;
  document.getElementById('checkin-modal').classList.add('hidden');
}

function confirmCheckin() {
  if (!pendingCheckin) return;
  const { id, type } = pendingCheckin;
  const plants = loadPlants();
  const plant = plants.find(p => p.id === id);
  const now = new Date().toISOString();

  const amount = document.getElementById('checkin-amount').value;
  const state = document.getElementById('checkin-state').value;
  const note = document.getElementById('checkin-note').value;

  if (type === 'water') {
    plant.lastWatered = now;
  } else {
    plant.lastFertilized = now;
  }

  if (!plant.history) plant.history = [];
  plant.history.unshift({
    date: now,
    type,
    amount: type === 'water' ? amount : '',
    state,
    note,
  });

  savePlants(plants);
  closeCheckin();
  render();
}

document.getElementById('checkin-cancel').addEventListener('click', closeCheckin);
document.getElementById('checkin-confirm').addEventListener('click', confirmCheckin);

// ---------- Actions ----------

function deletePlant(id) {
  if (!confirm('Удалить это растение?')) return;
  const plants = loadPlants().filter(p => p.id !== id);
  savePlants(plants);
  render();
}

// ---------- Edit modal ----------

function fillEditTypeFields(type, season) {
  const t = PLANT_TEMPLATES[type][season];
  document.getElementById('edit-water-freq').value = t.water;
  document.getElementById('edit-fertilize-freq').value = t.fertilize;
  document.getElementById('edit-note').value = generateTemplateNote(type, season);
  document.getElementById('edit-season-hint').textContent =
    `Подставлено для текущего периода (${season === 'summer' ? 'весна-лето, активный рост' : 'осень-зима, период покоя'}) — можешь поправить вручную.`;
}

function openEditModal(id) {
  editingPlantId = id;
  const plant = loadPlants().find(p => p.id === id);

  document.getElementById('edit-name').value = plant.name;
  document.getElementById('edit-plant-type').value = plant.plantType || '';
  document.getElementById('edit-water-freq').value = plant.waterFreq;
  document.getElementById('edit-last-watered').value = toDatetimeLocalValue(plant.lastWatered);
  updateLastWateredButtonLabel();
  document.getElementById('edit-fertilize-freq').value = plant.fertilizeFreq;
  document.getElementById('edit-pot-size').value = plant.potSize || '';
  document.getElementById('edit-location').value = plant.location || '';
  document.getElementById('edit-note').value = plant.note || '';
  document.getElementById('edit-season-hint').textContent = '';

  const ml = suggestedWaterMl(plant.potSize);
  document.getElementById('edit-water-amount-hint').textContent =
    ml ? `Рекомендуемый объём воды на один полив: ~${ml} мл` : '';

  const preview = document.getElementById('edit-photo-preview');
  const placeholder = document.getElementById('edit-photo-placeholder');
  if (plant.photo) {
    preview.src = plant.photo;
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }

  document.getElementById('edit-history-toggle').textContent = `📜 Открыть историю (${(plant.history || []).length})`;

  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  editingPlantId = null;
  document.getElementById('edit-modal').classList.add('hidden');
}

function saveEditModal() {
  const plants = loadPlants();
  const plant = plants.find(p => p.id === editingPlantId);

  plant.name = document.getElementById('edit-name').value;
  plant.plantType = document.getElementById('edit-plant-type').value || null;
  plant.waterFreq = Number(document.getElementById('edit-water-freq').value);
  const lastWateredInput = document.getElementById('edit-last-watered').value;
  if (lastWateredInput) plant.lastWatered = new Date(lastWateredInput).toISOString();
  plant.fertilizeFreq = Number(document.getElementById('edit-fertilize-freq').value);
  plant.potSize = document.getElementById('edit-pot-size').value;
  plant.location = document.getElementById('edit-location').value;
  plant.note = document.getElementById('edit-note').value;

  savePlants(plants);
  closeEditModal();
  render();
}

// ---------- Last watered modal ----------

function updateLastWateredButtonLabel() {
  const value = document.getElementById('edit-last-watered').value;
  const label = value
    ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
  document.getElementById('open-last-watered-btn').textContent = `🕐 Последний полив: ${label}`;
}

function openLastWateredModal() {
  document.getElementById('last-watered-input').value = document.getElementById('edit-last-watered').value;
  document.getElementById('last-watered-modal').classList.remove('hidden');
}

function closeLastWateredModal() {
  document.getElementById('last-watered-modal').classList.add('hidden');
}

document.getElementById('open-last-watered-btn').addEventListener('click', openLastWateredModal);
document.getElementById('last-watered-cancel').addEventListener('click', closeLastWateredModal);
document.getElementById('last-watered-close-x').addEventListener('click', closeLastWateredModal);
document.getElementById('last-watered-modal').addEventListener('click', (e) => {
  if (e.target.id === 'last-watered-modal') closeLastWateredModal();
});
document.getElementById('last-watered-save').addEventListener('click', () => {
  document.getElementById('edit-last-watered').value = document.getElementById('last-watered-input').value;
  updateLastWateredButtonLabel();
  closeLastWateredModal();
});

// ---------- History modal ----------

let historyModalPlantId = null;

function openHistoryModal(plantId) {
  historyModalPlantId = plantId;
  renderHistoryModal();
  document.getElementById('history-modal').classList.remove('hidden');
}

function closeHistoryModal() {
  historyModalPlantId = null;
  document.getElementById('history-modal').classList.add('hidden');
}

function renderHistoryModal() {
  const plant = loadPlants().find(p => p.id === historyModalPlantId);
  const list = document.getElementById('history-modal-list');
  const history = plant.history || [];

  if (history.length === 0) {
    list.innerHTML = '<p class="hint">Пока нет записей.</p>';
    return;
  }

  list.innerHTML = history.map((h, i) => `
    <div class="history-entry-row">
      <span class="history-entry">${formatHistoryEntry(h)}</span>
      <button class="history-delete-btn" data-index="${i}" title="Удалить запись">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.history-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      const plants = loadPlants();
      const p = plants.find(pl => pl.id === historyModalPlantId);
      p.history.splice(index, 1);
      savePlants(plants);
      renderHistoryModal();
      document.getElementById('edit-history-toggle').textContent = `📜 Открыть историю (${p.history.length})`;
    });
  });
}

document.getElementById('history-close-x').addEventListener('click', closeHistoryModal);
document.getElementById('history-back-btn').addEventListener('click', closeHistoryModal);
document.getElementById('history-modal').addEventListener('click', (e) => {
  if (e.target.id === 'history-modal') closeHistoryModal();
});

// ---------- Notifications ----------

function updateNotifyStatus() {
  const el = document.getElementById('notify-status');
  const btn = document.getElementById('enable-notify-btn');
  const testBtn = document.getElementById('test-notify-btn');
  if (!('Notification' in window)) {
    el.textContent = 'Уведомления не поддерживаются этим браузером.';
    btn.style.display = 'none';
    testBtn.classList.add('hidden');
    return;
  }
  if (Notification.permission === 'granted') {
    el.textContent = 'Уведомления включены ✅';
    btn.style.display = 'none';
    testBtn.classList.remove('hidden');
  } else if (Notification.permission === 'denied') {
    el.textContent = 'Уведомления заблокированы в настройках браузера.';
    btn.style.display = 'none';
    testBtn.classList.add('hidden');
  } else {
    el.textContent = '';
    btn.style.display = '';
    testBtn.classList.add('hidden');
  }
}

document.getElementById('enable-notify-btn').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  await Notification.requestPermission();
  updateNotifyStatus();
  maybeNotify(loadPlants());
});

document.getElementById('test-notify-btn').addEventListener('click', () => {
  new Notification('🌱 Тестовое уведомление', {
    body: 'Если ты это видишь (и слышишь звук) — уведомления настроены правильно!',
  });
});

function maybeNotify(plants) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const overdue = plants.filter(p => p.notifyEnabled !== false && (daysUntilNextWater(p) <= 0 || daysUntilNextFertilize(p) <= 0));
  if (overdue.length === 0) return;

  const lastNotified = localStorage.getItem(NOTIFY_DATE_KEY);
  if (lastNotified === todayStr()) return; // максимум одно напоминание в день

  const names = overdue.map(p => p.name).join(', ');
  new Notification('🌱 Пора позаботиться о цветах', {
    body: `Нужно внимание: ${names}`,
  });
  localStorage.setItem(NOTIFY_DATE_KEY, todayStr());
}

// ---------- Rendering ----------

function renderToday(plants) {
  const banner = document.getElementById('next-care-banner');
  const table = document.getElementById('care-table');
  const empty = document.getElementById('today-empty');

  if (plants.length === 0) {
    banner.innerHTML = '';
    table.innerHTML = '';
    empty.textContent = 'Пока нет растений — добавь первое на вкладке «Добавить растение».';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const events = plants
    .map(p => ({ plant: p, ...getNextCareEvent(p) }))
    .sort((a, b) => a.remainingMs - b.remainingMs);

  const next = events[0];
  const icon = next.type === 'water' ? '💧' : '🌿';
  const action = next.type === 'water' ? 'Полить' : 'Подкормить';

  banner.innerHTML = `
    <div class="next-care-icon">${icon}</div>
    <div class="next-care-text">
      <div class="next-care-title">${next.remainingMs <= 0 ? `${action} сейчас: «${next.plant.name}»` : `Следующий: «${next.plant.name}»`}</div>
      <div class="next-care-time">${next.remainingMs <= 0 ? 'Пора! ⚠️' : `${action.toLowerCase()} через ${formatDuration(next.remainingMs)}`}</div>
    </div>
  `;

  table.innerHTML = events.map(ev => `
    <div class="care-row ${ev.remainingMs <= 0 ? 'overdue' : ''}">
      <span class="care-row-icon">${ev.type === 'water' ? '💧' : '🌿'}</span>
      <span class="care-row-name">${ev.plant.name}</span>
      <span class="care-row-time">${ev.remainingMs <= 0 ? 'пора!' : formatDuration(ev.remainingMs)}</span>
    </div>
  `).join('');
}

function formatHistoryEntry(entry) {
  const date = new Date(entry.date).toLocaleDateString('ru-RU');
  const icon = entry.type === 'water' ? '💧' : '🌿';
  const parts = [date, icon];
  if (entry.amount) parts.push(`${entry.amount} мл`);
  if (entry.state && entry.state !== 'ок') parts.push(`— ${entry.state}`);
  if (entry.note) parts.push(`(${entry.note})`);
  return parts.join(' ');
}

function renderPlantList(plants) {
  const container = document.getElementById('plant-list');
  container.innerHTML = '';

  if (plants.length === 0) {
    container.innerHTML = '<p class="hint">Пока нет ни одного растения — добавь первое выше.</p>';
    return;
  }

  plants.forEach(p => {
    const cycleMs = p.waterFreq * 24 * 60 * 60 * 1000;
    const nextWaterAt = new Date(p.lastWatered).getTime() + cycleMs;
    const remainingMs = nextWaterAt - Date.now();
    const overdue = remainingMs <= 0 || daysUntilNextFertilize(p) <= 0;
    const elapsedPct = Math.min(100, Math.max(0, 100 - (remainingMs / cycleMs) * 100));

    const tile = document.createElement('div');
    tile.className = 'plant-tile';

    const notifyOn = p.notifyEnabled !== false;

    tile.innerHTML = `
      <button class="tile-bell-btn" title="${notifyOn ? 'Уведомления включены — нажми, чтобы выключить' : 'Уведомления выключены — нажми, чтобы включить'}">${notifyOn ? '🔔' : '🔕'}</button>
      <div class="plant-tile-photo">
        ${p.photo ? `<img src="${p.photo}" alt="${p.name}">` : '🌱'}
      </div>
      <div class="plant-tile-info">
        <div class="plant-tile-name">${p.name}</div>
        ${p.note ? `<div class="plant-tile-note">${p.note}</div>` : ''}
        <div class="countdown-bar"><div class="countdown-bar-fill ${overdue ? 'overdue' : ''}" style="width:${elapsedPct}%"></div></div>
        <div class="plant-tile-status ${overdue ? 'overdue' : ''}">
          ${overdue ? '⚠️ Пора позаботиться' : formatCountdown(remainingMs)}
        </div>
      </div>
    `;

    tile.addEventListener('click', () => openEditModal(p.id));
    tile.querySelector('.tile-bell-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const plants2 = loadPlants();
      const plant = plants2.find(pl => pl.id === p.id);
      plant.notifyEnabled = plant.notifyEnabled === false ? true : false;
      savePlants(plants2);
      renderPlantList(plants2);
    });
    container.appendChild(tile);
  });
}

function render() {
  const plants = loadPlants();
  renderToday(plants);
  renderPlantList(plants);
  updateNotifyStatus();
  maybeNotify(plants);
}

document.getElementById('plant-type').addEventListener('change', (e) => {
  const type = e.target.value;
  const hint = document.getElementById('season-hint');
  if (!type) {
    hint.textContent = '';
    return;
  }
  const season = getCurrentSeason();
  const t = PLANT_TEMPLATES[type][season];
  document.getElementById('water-freq').value = t.water;
  document.getElementById('fertilize-freq').value = t.fertilize;
  document.getElementById('note').value = generateTemplateNote(type, season);
  hint.textContent = `Подставлено для текущего периода (${season === 'summer' ? 'весна-лето, активный рост' : 'осень-зима, период покоя'}) — можешь поправить вручную.`;
});

document.getElementById('pot-size').addEventListener('input', (e) => {
  const ml = suggestedWaterMl(e.target.value);
  document.getElementById('water-amount-hint').textContent =
    ml ? `Рекомендуемый объём воды на один полив: ~${ml} мл` : '';
});

document.getElementById('photo-upload-btn').addEventListener('click', () => {
  document.getElementById('photo-input').click();
});

document.getElementById('photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const photo = await resizeImageFile(file);
  const preview = document.getElementById('photo-upload-preview');
  preview.src = photo;
  preview.classList.remove('hidden');
  document.getElementById('photo-upload-plus').classList.add('hidden');
});

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const plants = loadPlants();
  const now = new Date().toISOString();
  const photoFile = document.getElementById('photo-input').files[0];
  const photo = photoFile ? await resizeImageFile(photoFile) : null;

  plants.push({
    id: crypto.randomUUID(),
    name: document.getElementById('name').value,
    plantType: document.getElementById('plant-type').value || null,
    waterFreq: Number(document.getElementById('water-freq').value),
    fertilizeFreq: Number(document.getElementById('fertilize-freq').value),
    potSize: document.getElementById('pot-size').value,
    location: document.getElementById('location').value,
    photo,
    note: document.getElementById('note').value,
    notifyEnabled: true,
    lastWatered: now,
    lastFertilized: now,
    history: [],
  });

  savePlants(plants);
  e.target.reset();
  document.getElementById('water-freq').value = 7;
  document.getElementById('fertilize-freq').value = 30;
  document.getElementById('season-hint').textContent = '';
  document.getElementById('water-amount-hint').textContent = '';
  document.getElementById('photo-upload-preview').classList.add('hidden');
  document.getElementById('photo-upload-plus').classList.remove('hidden');
  render();
});

// ---------- Edit modal: wiring ----------

document.getElementById('edit-plant-type').addEventListener('change', (e) => {
  const type = e.target.value;
  if (!type) {
    document.getElementById('edit-season-hint').textContent = '';
    return;
  }
  fillEditTypeFields(type, getCurrentSeason());
});

document.getElementById('edit-pot-size').addEventListener('input', (e) => {
  const ml = suggestedWaterMl(e.target.value);
  document.getElementById('edit-water-amount-hint').textContent =
    ml ? `Рекомендуемый объём воды на один полив: ~${ml} мл` : '';
});

document.getElementById('edit-photo-btn').addEventListener('click', () => {
  document.getElementById('edit-photo-input').click();
});

document.getElementById('edit-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const photo = await resizeImageFile(file);
  const plants = loadPlants();
  const plant = plants.find(p => p.id === editingPlantId);
  plant.photo = photo;
  savePlants(plants);

  const preview = document.getElementById('edit-photo-preview');
  preview.src = photo;
  preview.classList.remove('hidden');
  document.getElementById('edit-photo-placeholder').classList.add('hidden');
});

document.getElementById('edit-history-toggle').addEventListener('click', () => {
  openHistoryModal(editingPlantId);
});

document.getElementById('edit-water-btn').addEventListener('click', () => {
  const id = editingPlantId;
  closeEditModal();
  openCheckin(id, 'water');
});
document.getElementById('edit-fertilize-btn').addEventListener('click', () => {
  const id = editingPlantId;
  closeEditModal();
  openCheckin(id, 'fertilize');
});

document.getElementById('edit-save-btn').addEventListener('click', saveEditModal);
document.getElementById('edit-cancel-btn').addEventListener('click', closeEditModal);
document.getElementById('edit-close-x').addEventListener('click', closeEditModal);
document.getElementById('edit-modal').addEventListener('click', (e) => {
  if (e.target.id === 'edit-modal') closeEditModal();
});
document.getElementById('edit-delete-btn').addEventListener('click', () => {
  const id = editingPlantId;
  closeEditModal();
  deletePlant(id);
});

// ---------- Tabs ----------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

async function initPlants() {
  try {
    const res = await fetch(`${FIREBASE_URL}/plants.json`);
    const cloudPlants = await res.json();
    if (cloudPlants) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudPlants));
    }
  } catch (e) {
    // нет интернета или Firebase недоступен — показываем то, что есть локально
  }
  render();
}

initPlants();

// обновляем обратный отсчёт до полива без перезагрузки страницы
setInterval(() => {
  const plants = loadPlants();
  renderToday(plants);
  renderPlantList(plants);
}, 60000);
