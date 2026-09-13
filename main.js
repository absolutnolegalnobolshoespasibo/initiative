// ============================================================================
//  Боевая инициатива — расширение для Owlbear Rodeo
//
//  Этот файл отвечает за интеграцию с OBR SDK, синхронизацию состояния
//  через метаданные комнаты/токенов и отрисовку интерфейса.
//  Сама логика "что считать, как сортировать" живёт в logic.js —
//  если хочешь разобраться в правилах боя, начни оттуда.
// ============================================================================

import OBR from "@owlbear-rodeo/sdk";
import {
  createDefaultState,
  getCharData,
  computeInitiative,
  computeBonus,
  startRoundParticipants,
  toggleReadyParticipants,
  allReady,
  readyCount,
  rankForBattle,
  nextIndexOrReset,
  splitByEditable,
} from "./logic.js";

// ----------------------------------------------------------------------------
//  Константы и ключи метаданных
// ----------------------------------------------------------------------------

// Префикс для всех ключей метаданных — чтобы не конфликтовать
// с другими расширениями.
const ID = "rodeo.kostya.initiative-tracker";

// Ключ, под которым общее состояние боя хранится в метаданных КОМНАТЫ
// (видно всем игрокам и мастеру, синхронизируется автоматически).
const ROOM_KEY = `${ID}/state`;

// Ключ, под которым персональные данные персонажа (изначальная
// инициатива, доступность для игроков) хранятся в метаданных ТОКЕНА.
const ITEM_KEY = `${ID}/data`;

// Звук начала раунда. Файл лежит рядом с index.html.
const BATTLE_SOUND_URL = "battebeginsound.mp3";

// Громкость звука: от 0 (тихо) до 1 (полная).
const BATTLE_SOUND_VOLUME = 1;

// Сколько миллисекунд держится анимация появления бейджа "+N".
const BONUS_ANIMATION_MS = 700;

// ----------------------------------------------------------------------------
//  Состояние приложения (хранится в памяти этой вкладки)
// ----------------------------------------------------------------------------

const app = document.getElementById("app");

let role = "PLAYER"; // роль текущего игрока: "GM" | "PLAYER"
let roleMap = new Map(); // userId -> "GM" | "PLAYER" (все подключённые)
let characters = []; // токены слоя CHARACTER, в порядке создания
let sceneReady = false; // открыта ли сцена прямо сейчас
let pendingAnimation = new Map(); // itemId -> до какого момента играть анимацию
let lastHtml = null; // последняя отрисованная разметка (чтобы не трогать DOM зря)

// Для какого раунда звук уже проигран — защита от повторного
// воспроизведения (мастер получает эхо собственного изменения метаданных).
let lastSoundRoundStartedAt = null;

// Состояние раунда/боя — хранится в метаданных комнаты и одинаково
// у всех подключённых клиентов.
let state = createDefaultState();

function isGM() {
  return role === "GM";
}

// ----------------------------------------------------------------------------
//  Звук начала раунда
// ----------------------------------------------------------------------------

const battleSound = new Audio(BATTLE_SOUND_URL);
battleSound.preload = "auto";
battleSound.volume = BATTLE_SOUND_VOLUME;

let audioUnlocked = false; // разрешил ли браузер звук в этой вкладке
let soundRequested = false; // просили ли уже проиграть звук "по-настоящему"

// Браузеры не дают проигрывать звук, пока пользователь не
// повзаимодействовал со страницей. Поэтому при первом же клике внутри
// попапа один раз "прокручиваем" звук беззвучно — после этого браузер
// разрешает воспроизведение, и игрок услышит начало следующего раунда.
function unlockAudio() {
  if (audioUnlocked || soundRequested) return;
  try {
    battleSound.muted = true;
    const played = battleSound.play();
    if (played && typeof played.then === "function") {
      played.then(
        () => {
          audioUnlocked = true;
          if (!soundRequested) {
            battleSound.pause();
            battleSound.currentTime = 0;
          }
          battleSound.muted = false;
          document.removeEventListener("pointerdown", unlockAudio);
        },
        () => {
          // Не получилось — попробуем при следующем клике.
          battleSound.muted = false;
        }
      );
    } else {
      audioUnlocked = true;
      battleSound.pause();
      battleSound.currentTime = 0;
      battleSound.muted = false;
    }
  } catch (e) {
    battleSound.muted = false;
  }
}

document.addEventListener("pointerdown", unlockAudio);

function playBattleSound() {
  try {
    soundRequested = true;
    battleSound.muted = false;
    battleSound.currentTime = 0;
    const played = battleSound.play();
    if (played && typeof played.catch === "function") {
      // Браузер всё ещё может запретить автовоспроизведение у игрока,
      // который ни разу не кликал внутри попапа — это не ошибка,
      // просто звук не прозвучит.
      played.catch(() => {});
    }
  } catch (e) {
    console.warn("Не удалось проиграть звук начала раунда", e);
  }
}

// Проиграть звук, если это действительно НОВЫЙ раунд (а не повторное
// применение того же состояния и не открытие попапа посреди раунда).
function maybePlayRoundSound(next) {
  if (!next || next.phase !== "round" || !next.roundStartedAt) return;
  if (next.roundStartedAt === lastSoundRoundStartedAt) return;
  lastSoundRoundStartedAt = next.roundStartedAt;
  playBattleSound();
}

// ----------------------------------------------------------------------------
//  Загрузка данных из Owlbear Rodeo
// ----------------------------------------------------------------------------

async function resolveRole() {
  // На большинстве версий SDK роль доступна синхронно как OBR.player.role.
  if (typeof OBR.player.role === "string") {
    return OBR.player.role;
  }
  // На случай более старого SDK — пробуем асинхронный метод.
  if (typeof OBR.player.getRole === "function") {
    try {
      return await OBR.player.getRole();
    } catch (e) {
      console.error("Не удалось получить роль игрока", e);
    }
  }
  return "PLAYER";
}

async function refreshRoleMap() {
  try {
    const others = await OBR.party.getPlayers();
    const map = new Map();
    for (const p of others) {
      map.set(p.id, p.role);
    }
    map.set(OBR.player.id, role);
    roleMap = map;
  } catch (e) {
    console.error("Не удалось получить список игроков", e);
  }
}

async function loadCharacters() {
  if (!sceneReady) {
    characters = [];
    render();
    return;
  }
  try {
    const items = await OBR.scene.items.getItems(
      (item) => item.layer === "CHARACTER" && item.type === "IMAGE"
    );
    items.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    characters = items;
  } catch (e) {
    console.error("Не удалось получить список персонажей", e);
    characters = [];
  }
  render();
}

// ----------------------------------------------------------------------------
//  Действия мастера/игроков — меняют состояние боя или метаданные токенов
// ----------------------------------------------------------------------------

// Сохраняет новое состояние боя: сразу применяет его локально (для
// мгновенного отклика интерфейса) и отправляет в метаданные комнаты,
// откуда оно разъедется по всем клиентам.
async function saveState(next) {
  state = next;
  render();
  try {
    await OBR.room.setMetadata({ [ROOM_KEY]: state });
  } catch (e) {
    console.error("Не удалось сохранить состояние боя", e);
  }
}

// 1)+2) "Начать раунд" — доступно только мастеру.
async function startRound() {
  if (!isGM() || characters.length === 0) return;

  const next = {
    ...createDefaultState(),
    phase: "round",
    roundStartedAt: Date.now(),
    participants: startRoundParticipants(characters),
  };

  // Важно: звук запускается синхронно, прямо в обработчике клика —
  // так браузер точно считает его "разрешённым пользователем".
  maybePlayRoundSound(next);

  await saveState(next);
}

// 3) Переключить галочку готовности персонажа.
async function toggleReady(itemId) {
  if (state.phase !== "round") return;

  const item = characters.find((c) => c.id === itemId);
  if (!item) return;

  const data = getCharData(item, roleMap, ITEM_KEY);
  if (!isGM() && !data.playerEditable) return; // нет прав на этого персонажа

  if (!state.participants[itemId]?.ready) {
    pendingAnimation.set(itemId, Date.now() + BONUS_ANIMATION_MS);
  }

  const participants = toggleReadyParticipants(state, itemId, Date.now());
  await saveState({ ...state, participants });
}

// 4) "В бой" — доступно мастеру, когда все готовы.
async function goToBattle() {
  if (!isGM() || state.phase !== "round" || !allReady(characters, state)) {
    return;
  }

  const now = Date.now();
  const { order, finalInitiative } = rankForBattle(
    characters,
    state,
    roleMap,
    ITEM_KEY,
    now
  );

  await saveState({
    ...state,
    phase: "battle",
    order,
    currentIndex: 0,
    finalInitiative,
  });

  await centerOn(order[0]);
}

// "Следующее существо" / переход в новый раунд, когда список закончился.
async function nextCreature() {
  if (!isGM() || state.phase !== "battle") return;

  const result = nextIndexOrReset(state);

  if (result.type === "reset") {
    // 5) Список закончился — возвращаемся к "Начать раунд".
    await saveState(createDefaultState());
    return;
  }

  await saveState({ ...state, currentIndex: result.index });
  await centerOn(state.order[result.index]);
}

// Сбросить текущий раунд/бой и вернуться к подготовке (доп. функция
// для мастера на случай ошибки — не описана в задании, но удобна).
async function resetTracker() {
  if (!isGM()) return;
  await saveState(createDefaultState());
}

// Подвинуть камеру так, чтобы персонаж оказался в центре экрана,
// не меняя текущий масштаб.
async function centerOn(itemId) {
  try {
    const [bounds, scale, width, height] = await Promise.all([
      OBR.scene.items.getItemBounds([itemId]),
      OBR.viewport.getScale(),
      OBR.viewport.getWidth(),
      OBR.viewport.getHeight(),
    ]);
    if (!bounds || !bounds.center) return;
    await OBR.viewport.animateTo({
      scale,
      position: {
        x: width / 2 - bounds.center.x * scale,
        y: height / 2 - bounds.center.y * scale,
      },
    });
  } catch (e) {
    console.error("Не удалось сфокусировать камеру на персонаже", e);
  }
}

// Изменить "изначальную инициативу" персонажа (поле в подготовке).
async function setInitialInitiative(itemId, value) {
  const v = Number.isFinite(value) ? Math.trunc(value) : 0;
  try {
    await OBR.scene.items.updateItems([itemId], (items) => {
      for (const item of items) {
        if (!item.metadata) item.metadata = {};
        const data = item.metadata[ITEM_KEY] || {};
        item.metadata[ITEM_KEY] = { ...data, initialInitiative: v };
      }
    });
  } catch (e) {
    console.error("Не удалось изменить изначальную инициативу", e);
  }
}

// Переключить "доступен игрокам" (PC) / "недоступен игрокам" (NPC).
async function setPlayerEditable(itemId, value) {
  try {
    await OBR.scene.items.updateItems([itemId], (items) => {
      for (const item of items) {
        if (!item.metadata) item.metadata = {};
        const data = item.metadata[ITEM_KEY] || {};
        item.metadata[ITEM_KEY] = { ...data, playerEditable: value };
      }
    });
  } catch (e) {
    console.error("Не удалось изменить доступность персонажа", e);
  }
}

// ----------------------------------------------------------------------------
//  Отрисовка интерфейса
// ----------------------------------------------------------------------------

// Собирает разметку целиком, ничего не меняя в DOM.
function buildHtml() {
  if (!sceneReady) {
    return `<div class="empty">Откройте сцену в Owlbear Rodeo,<br />чтобы увидеть трекер инициативы.</div>`;
  }

  let html = renderHeader();

  if (state.phase === "idle") {
    html += renderIdle();
  } else if (state.phase === "round") {
    html += renderRound();
  } else if (state.phase === "battle") {
    html += renderBattle();
  }

  return html;
}

// Запоминаем то, что теряется при замене innerHTML: позицию прокрутки
// списка и фокус в поле ввода.
function captureUiState() {
  const list = app.querySelector(".list");
  const active = document.activeElement;

  let focus = null;
  if (active && app.contains(active) && active.dataset && active.dataset.action) {
    let start = null;
    let end = null;
    try {
      start = active.selectionStart;
      end = active.selectionEnd;
    } catch (e) {
      // У некоторых типов полей (например number) выделение недоступно.
    }
    focus = {
      action: active.dataset.action,
      id: active.dataset.id || "",
      start,
      end,
    };
  }

  return { scrollTop: list ? list.scrollTop : 0, focus };
}

function restoreUiState(saved) {
  const list = app.querySelector(".list");
  if (list && saved.scrollTop) {
    list.scrollTop = saved.scrollTop;
  }

  if (!saved.focus) return;

  const idPart = saved.focus.id ? `[data-id="${cssEscape(saved.focus.id)}"]` : "";
  const el = app.querySelector(
    `[data-action="${cssEscape(saved.focus.action)}"]${idPart}`
  );
  if (!el) return;

  el.focus();
  if (saved.focus.start != null && typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(saved.focus.start, saved.focus.end);
    } catch (e) {
      // Тоже нормально: не все поля поддерживают выделение.
    }
  }
}

function cssEscape(value) {
  const str = String(value == null ? "" : value);
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(str);
  }
  return str.replace(/["\\]/g, "\\$&");
}

// Перерисовка. Если разметка не изменилась — DOM не трогаем вообще,
// иначе список каждый раз «прыгал» бы наверх.
function render() {
  const html = buildHtml();
  if (html === lastHtml) return;

  const ui = captureUiState();

  app.innerHTML = html;
  lastHtml = html;

  restoreUiState(ui);
  attachHandlers();
  cleanupAnimations();
}

// Убираем из очереди анимации то, что уже отыграло.
function cleanupAnimations() {
  const now = Date.now();
  for (const [id, until] of pendingAnimation) {
    if (until <= now) pendingAnimation.delete(id);
  }
}

function renderHeader() {
  let label = "Подготовка";
  let badgeClass = "";
  if (state.phase === "round") {
    label = "Раунд";
    badgeClass = "badge-round";
  } else if (state.phase === "battle") {
    label = "Бой";
    badgeClass = "badge-battle";
  }

  return `
    <div class="header">
      <div class="title">
        <svg class="die" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none">
          <path d="M12 1.5 L21 6.75 V17.25 L12 22.5 L3 17.25 V6.75 Z" fill="#E0A458" stroke="#3A2A1A" stroke-width="0.75" stroke-linejoin="round"/>
          <path d="M12 1.5 L12 12 M21 6.75 L12 12 M21 17.25 L12 12 M12 22.5 L12 12 M3 17.25 L12 12 M3 6.75 L12 12" stroke="#B5793A" stroke-width="0.6" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
        Инициатива
      </div>
      <div class="badge ${badgeClass}">${label}</div>
    </div>
  `;
}

// ---- Фаза подготовки ("idle") ----

function renderIdle() {
  if (characters.length === 0) {
    return `
      <div class="empty">
        На слое «Персонажи» (Character) пока нет токенов.<br />
        Добавьте токены на сцену, чтобы начать.
      </div>
      ${renderFooterIdle()}
    `;
  }

  const rows = characters
    .map((item) => {
      const data = getCharData(item, roleMap, ITEM_KEY);
      const canEditInitiative = isGM() || data.playerEditable;

      const tag = isGM()
        ? `<button
             class="tag-toggle ${data.playerEditable ? "is-pc" : "is-npc"}"
             data-action="toggle-editable"
             data-id="${item.id}"
             title="${
               data.playerEditable
                 ? "Доступен для редактирования игрокам. Нажмите, чтобы сделать NPC."
                 : "NPC/монстр — недоступен для редактирования игрокам. Нажмите, чтобы сделать PC."
             }"
           >${data.playerEditable ? "PC" : "NPC"}</button>`
        : "";

      return `
        <div class="row">
          ${renderAvatar(item)}
          <div class="name" title="${escapeAttr(item.name)}">${escapeHtml(
        item.name
      )}</div>
          <input
            type="number"
            class="init-input"
            inputmode="numeric"
            step="1"
            value="${data.initialInitiative}"
            data-action="set-initiative"
            data-id="${item.id}"
            ${canEditInitiative ? "" : "disabled"}
            title="Изначальная инициатива"
          />
          ${tag}
        </div>
      `;
    })
    .join("");

  return `
    <div class="list">${rows}</div>
    ${renderFooterIdle()}
  `;
}

function renderFooterIdle() {
  const disabled = !isGM() || characters.length === 0;
  return `
    <div class="footer">
      <button class="primary-btn" data-action="start-round" ${
        disabled ? "disabled" : ""
      }>Начать раунд</button>
      ${
        !isGM()
          ? `<div class="gm-note">Раунд может начать только мастер.</div>`
          : ""
      }
    </div>
  `;
}

// ---- Фаза раунда / ожидания готовности ("round") ----

function renderRound() {
  const { npc, pc } = splitByEditable(characters, roleMap, ITEM_KEY);

  let rows;
  if (isGM()) {
    rows = "";
    if (npc.length) {
      rows += `<div class="group-header">Недоступны игрокам</div>`;
      rows += npc.map(renderReadyRow).join("");
    }
    if (pc.length) {
      rows += `<div class="group-header">Доступны игрокам</div>`;
      rows += pc.map(renderReadyRow).join("");
    }
    if (!rows) {
      rows = `<div class="empty">Нет персонажей на сцене.</div>`;
    }
  } else {
    rows = pc.length
      ? pc.map(renderReadyRow).join("")
      : `<div class="empty">Нет персонажей, доступных для редактирования игроками.</div>`;
  }

  const ready = allReady(characters, state);
  const statusText = ready
    ? "Все готовы!"
    : `Готовы: ${readyCount(characters, state)} из ${characters.length}`;

  return `
    <div class="list">${rows}</div>
    <div class="status-line ${ready ? "is-ready" : ""}">${statusText}</div>
    <div class="footer">
      <button class="primary-btn" data-action="go-battle" ${
        !isGM() || !ready ? "disabled" : ""
      }>В бой</button>
      ${
        isGM()
          ? `<button class="text-btn" data-action="reset">Сбросить раунд</button>`
          : `<div class="gm-note">Переход в бой — решение мастера.</div>`
      }
    </div>
  `;
}

function renderReadyRow(item) {
  const data = getCharData(item, roleMap, ITEM_KEY);
  const canToggle = isGM() || data.playerEditable;
  const participant = state.participants[item.id];
  const ready = !!(participant && participant.ready);
  const total = computeInitiative(item, state, roleMap, ITEM_KEY, Date.now());
  const bonus = ready ? computeBonus(item, state) : 0;
  const isNewlyReady = (pendingAnimation.get(item.id) || 0) > Date.now();
  const bonusBadge =
    ready && bonus > 0
      ? `<span class="bonus-badge${isNewlyReady ? " is-new" : ""}">+${bonus}</span>`
      : "";

  return `
    <div class="row ${ready ? "is-ready" : ""}">
      ${renderAvatar(item)}
      <div class="name" title="${escapeAttr(item.name)}">${escapeHtml(
    item.name
  )}</div>
      <div class="current-init${ready ? "" : " muted-init"}">${total}${bonusBadge}</div>
      <input
        type="checkbox"
        class="ready-check"
        data-action="toggle-ready"
        data-id="${item.id}"
        ${ready ? "checked" : ""}
        ${canToggle ? "" : "disabled"}
        title="Готовность"
        aria-label="Готовность: ${escapeAttr(item.name)}"
      />
    </div>
  `;
}

// ---- Фаза боя ("battle") ----

function renderBattle() {
  const order = state.order || [];
  const finalInitiative = state.finalInitiative || {};

  const rows = order
    .map((id, index) => {
      const item = characters.find((c) => c.id === id);
      if (!item) return "";
      const isCurrent = index === state.currentIndex;
      const value = Number.isFinite(finalInitiative[id])
        ? finalInitiative[id]
        : "—";

      return `
        <div class="row ${isCurrent ? "is-current" : ""}">
          <div class="order-num">${index + 1}</div>
          ${renderAvatar(item)}
          <div class="name" title="${escapeAttr(item.name)}">${escapeHtml(
        item.name
      )}</div>
          <div class="current-init">${value}</div>
        </div>
      `;
    })
    .join("");

  const isLast =
    state.currentIndex === null || state.currentIndex >= order.length - 1;

  return `
    <div class="list">${rows}</div>
    <div class="footer">
      <button class="primary-btn" data-action="next-creature" ${
        !isGM() ? "disabled" : ""
      }>${
    isLast ? "Следующее существо → Начать раунд" : "Следующее существо"
  }</button>
      ${
        isGM()
          ? `<button class="text-btn" data-action="reset">Сбросить бой</button>`
          : `<div class="gm-note">Очередь хода ведёт мастер.</div>`
      }
    </div>
  `;
}

// ---- Общие мелочи отрисовки ----

function renderAvatar(item) {
  const url = item.image && item.image.url;
  if (url) {
    return `<img class="avatar" src="${escapeAttr(url)}" alt="" />`;
  }
  return `<div class="avatar avatar-placeholder"></div>`;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function escapeAttr(value) {
  return (value == null ? "" : String(value)).replace(/"/g, "&quot;");
}

// ----------------------------------------------------------------------------
//  Обработчики событий интерфейса (делегирование на #app)
// ----------------------------------------------------------------------------

function attachHandlers() {
  app.onclick = (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const { action, id } = target.dataset;

    switch (action) {
      case "start-round":
        startRound();
        break;
      case "go-battle":
        goToBattle();
        break;
      case "next-creature":
        nextCreature();
        break;
      case "reset":
        resetTracker();
        break;
      case "toggle-editable": {
        const item = characters.find((c) => c.id === id);
        if (item) {
          const data = getCharData(item, roleMap, ITEM_KEY);
          setPlayerEditable(id, !data.playerEditable);
        }
        break;
      }
      default:
        break;
    }
  };

  app.onchange = (event) => {
    const target = event.target;
    const { action, id } = target.dataset || {};

    if (action === "set-initiative") {
      setInitialInitiative(id, parseInt(target.value, 10));
    } else if (action === "toggle-ready") {
      toggleReady(id);
    }
  };

  // Enter в поле инициативы подтверждает значение (вызывает change).
  app.onkeydown = (event) => {
    if (
      event.key === "Enter" &&
      event.target.dataset &&
      event.target.dataset.action === "set-initiative"
    ) {
      event.target.blur();
    }
  };
}

// ----------------------------------------------------------------------------
//  Инициализация
// ----------------------------------------------------------------------------

async function init() {
  role = await resolveRole();
  await refreshRoleMap();

  // Изменения роли/состава партии — например, мастер передал права,
  // или подключился новый игрок.
  OBR.player.onChange(async (player) => {
    role = player.role;
    await refreshRoleMap();
    render();
  });

  OBR.party.onChange(async () => {
    await refreshRoleMap();
    render();
  });

  // Состояние боя хранится в метаданных комнаты и общее для всех.
  OBR.room.getMetadata().then((metadata) => {
    state = metadata[ROOM_KEY] || createDefaultState();
    // Раунд, который уже идёт к моменту открытия попапа, звуком
    // не сопровождаем.
    lastSoundRoundStartedAt = state.roundStartedAt ?? null;
    render();
  });

  OBR.room.onMetadataChange((metadata) => {
    const next = metadata[ROOM_KEY] || createDefaultState();
    state = next;
    // Звук слышат все, у кого открыт попап расширения.
    maybePlayRoundSound(next);
    render();
  });

  // Список персонажей зависит от открытой сцены.
  OBR.scene.onReadyChange((ready) => {
    sceneReady = ready;
    if (ready) {
      loadCharacters();
    } else {
      characters = [];
      render();
    }
  });

  OBR.scene.items.onChange(() => {
    loadCharacters();
  });

  render();
}

OBR.onReady(init);
