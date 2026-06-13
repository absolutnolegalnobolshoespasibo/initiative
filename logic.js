// ============================================================================
//  Боевая инициатива — чистая логика состояния боя.
//
//  Этот файл не трогает OBR SDK и DOM, поэтому его легко проверить
//  тестами (см. logic.test.mjs) и легко читать отдельно от
//  интерфейса/интеграции (main.js).
// ============================================================================

// Сколько прибавляется к "изначальной инициативе" при старте раунда.
export const ROUND_BONUS = 10;

// За сколько миллисекунд готовности инициатива падает на 1.
export const DECAY_INTERVAL_MS = 30_000;

// Состояние "до начала раунда" / "после окончания боя".
export function createDefaultState() {
  return {
    phase: "idle", // "idle" -> "round" -> "battle" -> ("idle")
    roundStartedAt: null, // когда нажали "Начать раунд" (timestamp, мс)
    participants: {}, // { [itemId]: { ready: bool, readyAt: number|null } }
    order: null, // [itemId, ...] — порядок боя после "В бой"
    currentIndex: null, // индекс текущего существа в order
    finalInitiative: null, // { [itemId]: number } — застывшие значения для боя
  };
}

// Достаём наши данные из метаданных токена, подставляя значения по
// умолчанию для персонажей, у которых их ещё нет.
//
// roleMap: Map<userId, "GM" | "PLAYER"> — роли всех, кто сейчас в комнате.
export function getCharData(item, roleMap, itemKey) {
  const raw = (item.metadata && item.metadata[itemKey]) || {};

  let playerEditable;
  if (typeof raw.playerEditable === "boolean") {
    playerEditable = raw.playerEditable;
  } else {
    // По умолчанию: токены, созданные мастером, считаем NPC/монстрами
    // (недоступны для редактирования игроками); всё остальное — PC.
    playerEditable = roleMap.get(item.createdUserId) !== "GM";
  }

  return {
    initialInitiative: Number.isFinite(raw.initialInitiative)
      ? raw.initialInitiative
      : 0,
    playerEditable,
  };
}

// Текущее значение инициативы персонажа с учётом угасания во время
// готовности (-1 за каждые DECAY_INTERVAL_MS миллисекунд).
export function computeInitiative(item, state, roleMap, itemKey, now) {
  const data = getCharData(item, roleMap, itemKey);
  const base = data.initialInitiative + ROUND_BONUS;

  const participant = state.participants[item.id];
  if (participant && participant.ready && typeof participant.readyAt === "number") {
    const elapsed = Math.max(0, now - participant.readyAt);
    const decay = Math.floor(elapsed / DECAY_INTERVAL_MS);
    return base - decay;
  }
  return base;
}

// Участники нового раунда: все текущие персонажи, никто не готов.
export function startRoundParticipants(characters) {
  const participants = {};
  for (const item of characters) {
    participants[item.id] = { ready: false, readyAt: null };
  }
  return participants;
}

// Переключить готовность персонажа. Возвращает новый объект participants
// (исходный не изменяется).
export function toggleReadyParticipants(state, itemId, now) {
  const participants = { ...state.participants };
  const current = participants[itemId] || { ready: false, readyAt: null };

  participants[itemId] = current.ready
    ? { ready: false, readyAt: null } // снять галочку -> вернуть инициативу
    : { ready: true, readyAt: now }; // поставить галочку -> запустить угасание

  return participants;
}

// Готовы ли все персонажи (после старта раунда)?
export function allReady(characters, state) {
  if (characters.length === 0) return false;
  return characters.every((c) => state.participants[c.id]?.ready);
}

export function readyCount(characters, state) {
  return characters.filter((c) => state.participants[c.id]?.ready).length;
}

// Считаем порядок боя: по инициативе по убыванию, при равенстве —
// кто раньше нажал готовность (меньший readyAt), тот выше.
//
// Возвращает { order: [itemId, ...], finalInitiative: { [itemId]: number } }.
export function rankForBattle(characters, state, roleMap, itemKey, now) {
  const ranked = characters.map((item) => ({
    id: item.id,
    initiative: computeInitiative(item, state, roleMap, itemKey, now),
    readyAt: state.participants[item.id]?.readyAt ?? now,
  }));

  ranked.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    return a.readyAt - b.readyAt;
  });

  const order = ranked.map((r) => r.id);
  const finalInitiative = {};
  for (const r of ranked) finalInitiative[r.id] = r.initiative;

  return { order, finalInitiative };
}

// Что делать при нажатии "Следующее существо":
// - если есть следующий индекс — перейти к нему;
// - если список закончился — сигнал "reset" (вернуться к "Начать раунд").
export function nextIndexOrReset(state) {
  if (!state.order) return { type: "reset" };
  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.order.length) {
    return { type: "reset" };
  }
  return { type: "advance", index: nextIndex };
}

// Разбивает список персонажей на NPC (недоступны игрокам) и PC
// (доступны игрокам), сохраняя исходный порядок внутри каждой группы.
export function splitByEditable(characters, roleMap, itemKey) {
  const npc = [];
  const pc = [];
  for (const item of characters) {
    const data = getCharData(item, roleMap, itemKey);
    (data.playerEditable ? pc : npc).push(item);
  }
  return { npc, pc };
}
