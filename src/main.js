// ============================================================================
//  Боевая инициатива — расширение для Owlbear Rodeo
//
//  Этот файл отвечает за интеграцию с OBR SDK, синхронизацию состояния
//  через метаданные комнаты/токенов и отрисовку интерфейса.
//  Сама логика "что считать, как сортировать" живёт в logic.js —
//  если хочешь разобраться в правилах боя, начни оттуда.
// ============================================================================

import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3.1.0";
import {
  ROUND_BONUS,
  createDefaultState,
  getCharData,
  computeInitiative,
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

// ----------------------------------------------------------------------------
//  Состояние приложения (хранится в памяти этой вкладки)
// ----------------------------------------------------------------------------

const app = document.getElementById("app");

let role = "PLAYER"; // роль текущего игрока: "GM" | "PLAYER"
let roleMap = new Map(); // userId -> "GM" | "PLAYER" (все подключённые)
let characters = []; // токены слоя CHARACTER, в порядке создания
let sceneReady = false; // открыта ли сцена прямо сейчас
let tickHandle = null; // setInterval для живого обновления таймера

// Состояние раунда/боя — хранится в метаданных комнаты и одинаково
// у всех подключённых клиентов.
let state = createDefaultState();

function isGM() {
  return role === "GM";
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

  await saveState({
    ...createDefaultState(),
    phase: "round",
    roundStartedAt: Date.now(),
    participants: startRoundParticipants(characters),
  });
}

// 3) Переключить галочку готовности персонажа.
async function toggleReady(itemId) {
  if (state.phase !== "round") return;

  const item = characters.find((c) => c.id === itemId);
  if (!item) return;

  const data = getCharData(item, roleMap, ITEM_KEY);
  if (!isGM() && !data.playerEditable) return; // нет прав на этого персонажа

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

// Подвинуть камеру так, чтобы персонаж оказался в центре экрана.
async function centerOn(itemId) {
  try {
    const bounds = await OBR.scene.items.getItemBounds([itemId]);
    if (bounds) {
      await OBR.viewport.animateToBounds(bounds);
    }
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

function render() {
  if (!sceneReady) {
    app.innerHTML = `<div class="empty">Откройте сцену в Owlbear Rodeo,<br />чтобы увидеть трекер инициативы.</div>`;
    manageTicking();
    return;
  }

  let html = renderHeader();

  if (state.phase === "round" || state.phase === "battle") {
    html += renderTimerRow();
  }

  if (state.phase === "idle") {
    html += renderIdle();
  } else if (state.phase === "round") {
    html += renderRound();
  } else if (state.phase === "battle") {
    html += renderBattle();
  }

  app.innerHTML = html;
  attachHandlers();
  manageTicking();
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

function renderTimerRow() {
  if (!state.roundStartedAt) return "";
  const elapsedSec = Math.max(
    0,
    Math.floor((Date.now() - state.roundStartedAt) / 1000)
  );
  const m = Math.floor(elapsedSec / 60)
    .toString()
    .padStart(2, "0");
  const s = (elapsedSec % 60).toString().padStart(2, "0");

  return `
    <div class="timer-row">
      <span class="timer">${m}:${s}</span>
      <span class="timer-label">с начала раунда</span>
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
    <div class="hint">
      Изначальная инициатива — стартовый модификатор персонажа
      (например, бонус Ловкости). В начале раунда к нему прибавляется
      +${ROUND_BONUS}.
    </div>
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
  const current = computeInitiative(item, state, roleMap, ITEM_KEY, Date.now());

  return `
    <div class="row ${ready ? "is-ready" : ""}">
      ${renderAvatar(item)}
      <div class="name" title="${escapeAttr(item.name)}">${escapeHtml(
    item.name
  )}</div>
      <div class="current-init">${current}</div>
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

// Каждую секунду перерисовываем интерфейс, если на экране есть
// что-то, меняющееся со временем (таймер, угасание инициативы).
function manageTicking() {
  const shouldTick = state.phase === "round" || state.phase === "battle";
  if (shouldTick && !tickHandle) {
    tickHandle = setInterval(render, 1000);
  } else if (!shouldTick && tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
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
    render();
  });
  OBR.room.onMetadataChange((metadata) => {
    state = metadata[ROOM_KEY] || createDefaultState();
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
