// ============================================================================
//  Тесты для logic.js — запускать через `node --test`.
//
//  Эти тесты не трогают OBR SDK и DOM: они проверяют только правила
//  расчёта инициативы, сортировки и переходов между фазами боя.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ROUND_BONUS,
  DECAY_INTERVAL_MS,
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

const ITEM_KEY = "test/data";

// Небольшой помощник для создания "токенов" так, как их вернул бы
// OBR.scene.items.getItems().
function makeItem(id, { createdUserId, initialInitiative, playerEditable } = {}) {
  const metadata = {};
  if (initialInitiative !== undefined || playerEditable !== undefined) {
    metadata[ITEM_KEY] = {};
    if (initialInitiative !== undefined) {
      metadata[ITEM_KEY].initialInitiative = initialInitiative;
    }
    if (playerEditable !== undefined) {
      metadata[ITEM_KEY].playerEditable = playerEditable;
    }
  }
  return { id, name: id, createdUserId, metadata, layer: "CHARACTER", type: "IMAGE" };
}

test("ROUND_BONUS и DECAY_INTERVAL_MS имеют ожидаемые значения", () => {
  assert.equal(ROUND_BONUS, 10);
  assert.equal(DECAY_INTERVAL_MS, 30_000);
});

// ----------------------------------------------------------------------------
//  getCharData
// ----------------------------------------------------------------------------

test("getCharData: значения по умолчанию для нового персонажа", () => {
  const item = makeItem("a");
  const roleMap = new Map();
  const data = getCharData(item, roleMap, ITEM_KEY);
  assert.equal(data.initialInitiative, 0);
  // Создатель неизвестен -> не "GM" -> считаем PC (доступен игрокам).
  assert.equal(data.playerEditable, true);
});

test("getCharData: токен мастера по умолчанию считается NPC", () => {
  const item = makeItem("monster", { createdUserId: "gm-1" });
  const roleMap = new Map([["gm-1", "GM"], ["player-1", "PLAYER"]]);
  const data = getCharData(item, roleMap, ITEM_KEY);
  assert.equal(data.playerEditable, false);
});

test("getCharData: токен игрока по умолчанию считается PC", () => {
  const item = makeItem("hero", { createdUserId: "player-1" });
  const roleMap = new Map([["gm-1", "GM"], ["player-1", "PLAYER"]]);
  const data = getCharData(item, roleMap, ITEM_KEY);
  assert.equal(data.playerEditable, true);
});

test("getCharData: явные метаданные перекрывают значения по умолчанию", () => {
  const item = makeItem("hero", {
    createdUserId: "player-1",
    initialInitiative: 3,
    playerEditable: false, // мастер вручную пометил как NPC
  });
  const roleMap = new Map([["player-1", "PLAYER"]]);
  const data = getCharData(item, roleMap, ITEM_KEY);
  assert.equal(data.initialInitiative, 3);
  assert.equal(data.playerEditable, false);
});

// ----------------------------------------------------------------------------
//  computeInitiative
// ----------------------------------------------------------------------------

test("computeInitiative: без готовности возвращает initial + 10", () => {
  const item = makeItem("a", { initialInitiative: 4 });
  const state = createDefaultState();
  const value = computeInitiative(item, state, new Map(), ITEM_KEY, 0);
  assert.equal(value, 4 + ROUND_BONUS);
});

test("computeInitiative: угасание -1 за каждые 30 секунд готовности", () => {
  const item = makeItem("a", { initialInitiative: 5 }); // база = 15
  const state = createDefaultState();
  state.participants["a"] = { ready: true, readyAt: 0 };

  const cases = [
    [0, 15],
    [29_999, 15], // чуть меньше 30с -> ещё без штрафа
    [30_000, 14], // ровно 30с -> -1
    [59_999, 14],
    [60_000, 13], // 60с -> -2
    [65_000, 13],
    [90_000, 12], // 90с -> -3
  ];

  for (const [now, expected] of cases) {
    assert.equal(
      computeInitiative(item, state, new Map(), ITEM_KEY, now),
      expected,
      `at now=${now}`
    );
  }
});

test("computeInitiative: снятие готовности возвращает базовое значение", () => {
  const item = makeItem("a", { initialInitiative: 5 });
  let state = createDefaultState();

  // Поставили готовность в момент 0.
  state.participants["a"] = { ready: true, readyAt: 0 };
  assert.equal(computeInitiative(item, state, new Map(), ITEM_KEY, 65_000), 13);

  // Сняли готовность -> participants["a"] = {ready:false, readyAt:null}.
  const after = toggleReadyParticipants(state, "a", 65_000);
  state = { ...state, participants: after };
  assert.equal(computeInitiative(item, state, new Map(), ITEM_KEY, 100_000), 15);
});

// ----------------------------------------------------------------------------
//  startRoundParticipants / toggleReadyParticipants
// ----------------------------------------------------------------------------

test("startRoundParticipants: все персонажи не готовы", () => {
  const characters = [makeItem("a"), makeItem("b")];
  const participants = startRoundParticipants(characters);
  assert.deepEqual(participants, {
    a: { ready: false, readyAt: null },
    b: { ready: false, readyAt: null },
  });
});

test("toggleReadyParticipants: переключает готовность в обе стороны и не мутирует исходный объект", () => {
  const state = createDefaultState();
  state.participants = { a: { ready: false, readyAt: null } };

  const afterOn = toggleReadyParticipants(state, "a", 1000);
  assert.deepEqual(afterOn.a, { ready: true, readyAt: 1000 });
  // Исходный объект не изменился.
  assert.deepEqual(state.participants.a, { ready: false, readyAt: null });

  const stateOn = { ...state, participants: afterOn };
  const afterOff = toggleReadyParticipants(stateOn, "a", 2000);
  assert.deepEqual(afterOff.a, { ready: false, readyAt: null });
});

// ----------------------------------------------------------------------------
//  allReady / readyCount
// ----------------------------------------------------------------------------

test("allReady: пустой список персонажей -> false", () => {
  const state = createDefaultState();
  assert.equal(allReady([], state), false);
});

test("allReady и readyCount считают готовность корректно", () => {
  const characters = [makeItem("a"), makeItem("b"), makeItem("c")];
  let state = createDefaultState();
  state.participants = startRoundParticipants(characters);

  assert.equal(allReady(characters, state), false);
  assert.equal(readyCount(characters, state), 0);

  state.participants = toggleReadyParticipants(state, "a", 0);
  state.participants = toggleReadyParticipants(state, "b", 0);
  assert.equal(allReady(characters, state), false);
  assert.equal(readyCount(characters, state), 2);

  state.participants = toggleReadyParticipants(state, "c", 0);
  assert.equal(allReady(characters, state), true);
  assert.equal(readyCount(characters, state), 3);
});

// ----------------------------------------------------------------------------
//  rankForBattle
// ----------------------------------------------------------------------------

test("rankForBattle: сортирует по инициативе по убыванию", () => {
  const characters = [
    makeItem("low", { initialInitiative: 0 }), // 10
    makeItem("high", { initialInitiative: 5 }), // 15
    makeItem("mid", { initialInitiative: 2 }), // 12
  ];
  let state = createDefaultState();
  state.participants = startRoundParticipants(characters);
  for (const c of characters) {
    state.participants = toggleReadyParticipants(state, c.id, 0);
  }

  const { order, finalInitiative } = rankForBattle(
    characters,
    state,
    new Map(),
    ITEM_KEY,
    0
  );

  assert.deepEqual(order, ["high", "mid", "low"]);
  assert.deepEqual(finalInitiative, { high: 15, mid: 12, low: 10 });
});

test("rankForBattle: при равной инициативе выше тот, кто раньше нажал готовность", () => {
  // Оба персонажа имеют одинаковую базовую инициативу (15).
  const characters = [
    makeItem("b", { initialInitiative: 5 }),
    makeItem("c", { initialInitiative: 5 }),
    makeItem("a", { initialInitiative: -8 }), // 2, явно ниже
  ];
  let state = createDefaultState();
  state.participants = startRoundParticipants(characters);

  // b нажал готовность первым (t=0), c — позже (t=1000), a — последним (t=2000).
  state.participants = toggleReadyParticipants(state, "b", 0);
  state.participants = toggleReadyParticipants(state, "c", 1000);
  state.participants = toggleReadyParticipants(state, "a", 2000);

  const { order, finalInitiative } = rankForBattle(
    characters,
    state,
    new Map(),
    ITEM_KEY,
    2000 // "сейчас" — момент нажатия "В бой"
  );

  // b и c оба по 15, но b готов раньше -> выше; a с инициативой 2 — последний.
  assert.deepEqual(order, ["b", "c", "a"]);
  assert.deepEqual(finalInitiative, { b: 15, c: 15, a: 2 });
});

test("rankForBattle: угасание может изменить порядок", () => {
  // Оба стартуют с базой 15, но "early" готов уже 65с -> 15-2=13,
  // а "late" готов 0с -> 15. late должен оказаться выше.
  const characters = [
    makeItem("early", { initialInitiative: 5 }),
    makeItem("late", { initialInitiative: 5 }),
  ];
  let state = createDefaultState();
  state.participants = {
    early: { ready: true, readyAt: 0 },
    late: { ready: true, readyAt: 65_000 },
  };

  const { order, finalInitiative } = rankForBattle(
    characters,
    state,
    new Map(),
    ITEM_KEY,
    65_000
  );

  assert.deepEqual(order, ["late", "early"]);
  assert.deepEqual(finalInitiative, { late: 15, early: 13 });
});

// ----------------------------------------------------------------------------
//  nextIndexOrReset
// ----------------------------------------------------------------------------

test("nextIndexOrReset: продвигается по списку и сбрасывается в конце", () => {
  let state = {
    ...createDefaultState(),
    phase: "battle",
    order: ["a", "b", "c"],
    currentIndex: 0,
  };

  let result = nextIndexOrReset(state);
  assert.deepEqual(result, { type: "advance", index: 1 });

  state = { ...state, currentIndex: 1 };
  result = nextIndexOrReset(state);
  assert.deepEqual(result, { type: "advance", index: 2 });

  state = { ...state, currentIndex: 2 };
  result = nextIndexOrReset(state);
  assert.deepEqual(result, { type: "reset" });
});

test("nextIndexOrReset: без order -> reset", () => {
  const state = createDefaultState();
  assert.deepEqual(nextIndexOrReset(state), { type: "reset" });
});

// ----------------------------------------------------------------------------
//  splitByEditable
// ----------------------------------------------------------------------------

test("splitByEditable: делит персонажей на NPC и PC, сохраняя порядок", () => {
  const characters = [
    makeItem("goblin", { playerEditable: false }),
    makeItem("hero1", { playerEditable: true }),
    makeItem("ogre", { playerEditable: false }),
    makeItem("hero2", { playerEditable: true }),
  ];

  const { npc, pc } = splitByEditable(characters, new Map(), ITEM_KEY);

  assert.deepEqual(npc.map((c) => c.id), ["goblin", "ogre"]);
  assert.deepEqual(pc.map((c) => c.id), ["hero1", "hero2"]);
});

// ----------------------------------------------------------------------------
//  Сквозной сценарий: от старта раунда до конца боя
// ----------------------------------------------------------------------------

test("сквозной сценарий: раунд -> готовность -> бой -> следующий раунд", () => {
  const characters = [
    makeItem("goblin", { createdUserId: "gm", initialInitiative: 2 }), // NPC, база 12
    makeItem("hero-b", { createdUserId: "player-b", initialInitiative: 5 }), // PC, база 15
    makeItem("hero-c", { createdUserId: "player-c", initialInitiative: 5 }), // PC, база 15
  ];
  const roleMap = new Map([
    ["gm", "GM"],
    ["player-b", "PLAYER"],
    ["player-c", "PLAYER"],
  ]);

  // 2) Начать раунд.
  let state = {
    ...createDefaultState(),
    phase: "round",
    roundStartedAt: 0,
    participants: startRoundParticipants(characters),
  };
  assert.equal(allReady(characters, state), false);

  // 3) Готовность: hero-b в момент 0, hero-c в момент 1000, goblin в момент 2000.
  state.participants = toggleReadyParticipants(state, "hero-b", 0);
  state.participants = toggleReadyParticipants(state, "hero-c", 1000);
  state.participants = toggleReadyParticipants(state, "goblin", 2000);
  assert.equal(allReady(characters, state), true);

  // 4) "В бой" в момент 2000 — угасание ещё не успело сработать (< 30с).
  const { order, finalInitiative } = rankForBattle(
    characters,
    state,
    roleMap,
    ITEM_KEY,
    2000
  );
  // hero-b и hero-c равны (15), но hero-b готов раньше -> выше.
  // goblin (12) — последний.
  assert.deepEqual(order, ["hero-b", "hero-c", "goblin"]);
  assert.deepEqual(finalInitiative, {
    "hero-b": 15,
    "hero-c": 15,
    goblin: 12,
  });

  state = {
    ...state,
    phase: "battle",
    order,
    currentIndex: 0,
    finalInitiative,
  };

  // 5) "Следующее существо" два раза продвигает индекс...
  let step = nextIndexOrReset(state);
  assert.deepEqual(step, { type: "advance", index: 1 });
  state = { ...state, currentIndex: step.index };

  step = nextIndexOrReset(state);
  assert.deepEqual(step, { type: "advance", index: 2 });
  state = { ...state, currentIndex: step.index };

  // ...а на последнем существе — сигнал вернуться к "Начать раунд".
  step = nextIndexOrReset(state);
  assert.deepEqual(step, { type: "reset" });
});
