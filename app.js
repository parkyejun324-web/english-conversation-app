// ---------------------------------------------------------------------------
// 1단계: 프로젝트 뼈대 + localStorage 영구 저장 설계
// 2단계: Web Speech API로 음성 입력(STT)·출력(TTS) 연결
// 3단계: Gemini API로 실시간 대화 응답 연결
// 4단계: 대화 종료 후 교정 피드백 생성·저장·표시
// 5단계: 상황별 시나리오 확장(카테고리별) + 난이도별 응답 길이·TTS 속도 조절
//
// 주의: API 키를 브라우저에 직접 저장하고 fetch로 바로 호출하는 방식이라
// 같은 브라우저를 쓰는 다른 사람에게 노출될 수 있다. 개인 로컬 사용 전제.
// ---------------------------------------------------------------------------

const STORAGE_KEYS = {
  sessions: "eng_app_sessions",
  currentSessionId: "eng_app_current_session_id",
  feedbackHistory: "eng_app_feedback_history",
  errorStats: "eng_app_error_stats",
  apiKey: "eng_app_gemini_api_key",
};

const GEMINI_MODEL = "gemini-3.8-flash"; // 무료 등급에서 쓸 수 있는 빠른 모델
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// 매 요청마다 전체 대화 기록을 다시 보내면 턴이 쌓일수록 토큰(=무료 한도) 소모가
// 눈덩이처럼 불어난다. 최근 메시지만 잘라서 보낸다 — 홀수여야 자른 뒤에도 user 턴으로
// 시작한다(기록은 항상 user, ai, user, ai... 순서이고 마지막은 방금 추가된 user 턴이라서).
const MAX_HISTORY_MESSAGES = 9;

// 시나리오는 코드로만 관리한다(사용자가 만들지 않음) — localStorage에 저장하지 않고
// 항상 이 배열을 그대로 사용해서, 코드에서 시나리오를 추가/수정하면 바로 반영되게 한다.
const DEFAULT_SCENARIOS = [
  {
    id: "free-talk",
    category: "일상 회화",
    title: "자유 대화",
    role: "친근한 대화 상대",
    goal: "주제 제한 없이 자유롭게 영어로 대화하기",
    difficulty: "중급",
    startLine: "Hi! What would you like to talk about today?",
    systemPrompt:
      "You are a friendly English conversation partner. Reply only in English.",
  },
  {
    id: "job-interview",
    category: "비즈니스",
    title: "면접",
    role: "면접관",
    goal: "자기소개와 지원 동기를 영어로 설명하기",
    difficulty: "고급",
    startLine: "Thanks for coming in today. Could you start by introducing yourself?",
    systemPrompt:
      "You are a job interviewer. Stay in character, reply only in English.",
  },
  {
    id: "business-meeting",
    category: "비즈니스",
    title: "비즈니스 미팅",
    role: "회사 동료/클라이언트",
    goal: "프로젝트 진행 상황을 설명하고 다음 일정을 조율하기",
    difficulty: "고급",
    startLine: "Thanks for joining. Could you give us a quick update on where the project stands?",
    systemPrompt:
      "You are a colleague in a professional business meeting. Use a polite, professional tone. Stay in character, reply only in English.",
  },
  {
    id: "small-talk",
    category: "소셜",
    title: "스몰톡",
    role: "직장 동료 또는 새로 만난 사람",
    goal: "날씨, 주말 계획 등 가벼운 주제로 자연스럽게 대화 나누기",
    difficulty: "중급",
    startLine: "Hey, how was your weekend?",
    systemPrompt:
      "You are a friendly acquaintance making casual small talk. Keep it light and casual. Stay in character, reply only in English.",
  },
];

const DIFFICULTY_SETTINGS = {
  초급: {
    maxSentences: 1,
    vocab: "very simple, basic everyday vocabulary",
    guidance: "If the learner seems confused, gently simplify your wording.",
    ttsRate: 0.85,
  },
  중급: {
    maxSentences: 2,
    vocab: "natural, everyday vocabulary",
    guidance: "Respond naturally without extra hints.",
    ttsRate: 1.0,
  },
  고급: {
    maxSentences: 3,
    vocab: "natural, idiomatic, native-level vocabulary and expressions",
    guidance: "Do not simplify or give hints; respond as you would to a fluent speaker.",
    ttsRate: 1.1,
  },
};

function getDifficultySettings(difficulty) {
  return DIFFICULTY_SETTINGS[difficulty] || DIFFICULTY_SETTINGS["중급"];
}

// ---------------------------------------------------------------------------
// state 저장/복원
// ---------------------------------------------------------------------------

function loadState() {
  const read = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.warn(`[loadState] ${key} 파싱 실패, 기본값 사용`, err);
      return fallback;
    }
  };

  // 예전 버전에서 저장해두었던 시나리오 캐시가 있으면 정리한다(지금은 코드의
  // DEFAULT_SCENARIOS를 항상 그대로 쓰므로, 남아있으면 새 시나리오가 안 보인다).
  localStorage.removeItem("eng_app_scenarios");
  // Claude API를 쓰던 시절에 저장해둔 키는 Gemini 키와 형식이 달라 그대로 쓸 수 없으니 정리한다.
  localStorage.removeItem("eng_app_api_key");

  const state = {
    scenarios: DEFAULT_SCENARIOS,
    sessions: read(STORAGE_KEYS.sessions, []),
    currentSessionId: read(STORAGE_KEYS.currentSessionId, null),
    feedbackHistory: read(STORAGE_KEYS.feedbackHistory, []),
    errorStats: read(STORAGE_KEYS.errorStats, {}),
  };

  console.log("[loadState] 복원된 state:", state);
  return state;
}

function saveState() {
  localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(state.sessions));
  localStorage.setItem(STORAGE_KEYS.currentSessionId, JSON.stringify(state.currentSessionId));
  localStorage.setItem(STORAGE_KEYS.feedbackHistory, JSON.stringify(state.feedbackHistory));
  localStorage.setItem(STORAGE_KEYS.errorStats, JSON.stringify(state.errorStats));
  console.log("[saveState] 저장됨:", state);
}

let state = loadState();

// ---------------------------------------------------------------------------
// 화면 전환
// ---------------------------------------------------------------------------

const screens = {
  scenario: document.getElementById("screen-scenario"),
  conversation: document.getElementById("screen-conversation"),
  feedback: document.getElementById("screen-feedback"),
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
}

// ---------------------------------------------------------------------------
// 시나리오 선택 화면
// ---------------------------------------------------------------------------

function findScenario(scenarioId) {
  return state.scenarios.find((s) => s.id === scenarioId);
}

function renderScenarios() {
  const list = document.getElementById("scenario-list");
  list.innerHTML = "";

  const categories = [...new Set(state.scenarios.map((s) => s.category))];

  categories.forEach((category) => {
    const heading = document.createElement("h3");
    heading.className = "category-title";
    heading.textContent = category;
    list.appendChild(heading);

    state.scenarios
      .filter((s) => s.category === category)
      .forEach((scenario) => {
        const card = document.createElement("button");
        card.className = "scenario-card";
        card.innerHTML = `
          <div class="scenario-title">${scenario.title}</div>
          <div class="scenario-meta">${scenario.role} · 난이도: ${scenario.difficulty}</div>
        `;
        card.addEventListener("click", () => startSession(scenario.id));
        list.appendChild(card);
      });
  });
}

// ---------------------------------------------------------------------------
// 대화 세션
// ---------------------------------------------------------------------------

function findSession(sessionId) {
  return state.sessions.find((s) => s.id === sessionId);
}

function getCurrentSession() {
  return state.currentSessionId ? findSession(state.currentSessionId) : null;
}

function startSession(scenarioId) {
  const scenario = findScenario(scenarioId);
  if (!scenario) return;

  const session = {
    id: `session-${Date.now()}`,
    scenarioId: scenario.id,
    status: "active", // active | ended
    startedAt: new Date().toISOString(),
    endedAt: null,
    messages: [],
    corrections: [], // 대화 중 실시간으로 짚어준 교정 모음 — 종료 후 피드백 화면에 바로 씀
  };

  state.sessions.push(session);
  state.currentSessionId = session.id;
  saveState();

  openConversationScreen(session);
  addMessage(session, "ai", scenario.startLine);
}

function openConversationScreen(session) {
  const scenario = findScenario(session.scenarioId);
  document.getElementById("conversation-title").textContent = scenario
    ? `대화 · ${scenario.title}`
    : "대화";
  renderChat(session);
  showScreen("conversation");
}

function renderChat(session) {
  const log = document.getElementById("chat-log");
  log.innerHTML = "";

  if (session.messages.length === 0) {
    log.innerHTML = `<div class="empty-hint">아직 대화가 없습니다.</div>`;
    return;
  }

  session.messages.forEach((msg) => {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${msg.speaker === "user" ? "user" : "ai"}`;

    const textSpan = document.createElement("span");
    textSpan.className = "bubble-text";
    textSpan.textContent = msg.text;
    bubble.appendChild(textSpan);

    if (msg.speaker === "ai") {
      const replayBtn = document.createElement("button");
      replayBtn.className = "replay-btn";
      replayBtn.textContent = "🔊";
      replayBtn.title = "다시 듣기";
      const scenario = findScenario(session.scenarioId);
      const rate = getDifficultySettings(scenario?.difficulty).ttsRate;
      replayBtn.addEventListener("click", () => speakText(msg.text, rate));
      bubble.appendChild(replayBtn);
    }

    log.appendChild(bubble);
  });

  log.scrollTop = log.scrollHeight;
}

function addMessage(session, speaker, text) {
  session.messages.push({ speaker, text, timestamp: new Date().toISOString() });
  saveState();
  renderChat(session);
  if (speaker === "ai") {
    const scenario = findScenario(session.scenarioId);
    speakText(text, getDifficultySettings(scenario?.difficulty).ttsRate);
  }
}

// ---------------------------------------------------------------------------
// LLM 연동 (Gemini API) — 사용자가 말하면 AI가 영어로 응답한다
// ---------------------------------------------------------------------------

function getApiKey() {
  return localStorage.getItem(STORAGE_KEYS.apiKey) || "";
}

function setApiKey(key) {
  localStorage.setItem(STORAGE_KEYS.apiKey, key);
}

function setupApiKeyUI() {
  const input = document.getElementById("api-key-input");
  const status = document.getElementById("api-key-status");
  const saved = getApiKey();

  if (saved) {
    input.value = saved;
    status.textContent = "API 키가 저장되어 있습니다.";
  } else {
    status.textContent = "AI 응답을 받으려면 Gemini API 키를 입력하세요.";
  }

  document.getElementById("btn-save-key").addEventListener("click", () => {
    const value = input.value.trim();
    setApiKey(value);
    status.textContent = value ? "저장되었습니다." : "API 키가 비어 있습니다.";
  });
}

let awaitingReply = false;

function setTyping(isTyping) {
  awaitingReply = isTyping;
  const log = document.getElementById("chat-log");
  const existing = document.getElementById("typing-indicator");
  if (existing) existing.remove();

  if (isTyping) {
    const bubble = document.createElement("div");
    bubble.id = "typing-indicator";
    bubble.className = "bubble ai typing";
    bubble.textContent = "…";
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
  }
}

function setInputEnabled(enabled) {
  const micBtn = document.getElementById("btn-mic");
  const submitBtn = document.querySelector("#form-text-input button[type=submit]");
  if (micSupported) micBtn.disabled = !enabled;
  submitBtn.disabled = !enabled;
}

function handleUserTurn(session, text) {
  if (awaitingReply) return; // 이전 응답을 기다리는 중에는 새 발화를 막는다
  addMessage(session, "user", text);
  requestAiReply(session);
}

async function requestAiReply(session) {
  const scenario = findScenario(session.scenarioId);
  if (!scenario) return;

  if (!getApiKey()) {
    setMicStatus("AI 응답을 받으려면 상단 설정에서 Gemini API 키를 입력해주세요.");
    return;
  }

  setTyping(true);
  setInputEnabled(false);

  try {
    // 시작 멘트(session.messages[0])는 스크립트로 넣은 것이므로 system 프롬프트에만
    // 알려주고, API에는 그 이후 사용자/AI 주고받은 턴부터 보낸다(항상 user로 시작).
    // 대화가 길어질수록 매번 전체 기록을 다시 보내면 토큰 사용량이 눈덩이처럼 불어나
    // 무료 한도를 금방 써버리므로, 최근 몇 턴만 보낸다.
    const turns = session.messages.slice(1).slice(-MAX_HISTORY_MESSAGES);
    const result = await callGemini(scenario, turns);
    setTyping(false);
    if (session.status !== "active") return; // 응답이 오기 전에 대화가 종료된 경우 버린다
    addMessage(session, "ai", result.text);
    if (result.correction) {
      session.corrections = session.corrections || [];
      session.corrections.push(result.correction);
      saveState();
    }
  } catch (err) {
    setTyping(false);
    console.error("[requestAiReply] 실패:", err);
    setMicStatus(`AI 응답을 가져오지 못했습니다: ${err.message}`);
  } finally {
    setInputEnabled(true);
  }
}

// Gemini 무료 등급은 서버가 바쁠 때 503(일시 과부하)이나 429(요청 과다)를
// 자주 반환한다. 둘 다 "내 요청이 잘못된 게 아니라 잠깐 다시 해보면 되는" 에러라
// 짧게 텀을 두고 재시도한다 — 단, 재시도도 무료 한도를 쓰는 요청이라 1번만 한다.
async function callGeminiApi(body, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": getApiKey(),
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return res.json();

    const retryable = res.status === 503 || res.status === 429;
    if (retryable && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      continue;
    }

    const errText = await res.text();
    if (res.status === 503) {
      throw new Error("Gemini 서버가 일시적으로 과부하 상태입니다. 잠시 후 다시 시도해주세요.");
    }
    if (res.status === 429) {
      throw new Error("무료 등급 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.");
    }
    throw new Error(`${res.status} ${errText.slice(0, 200)}`);
  }
}

async function callGemini(scenario, turns) {
  const settings = getDifficultySettings(scenario.difficulty);
  // 자연어 지시문("라벨 쓰지 마라", "대화를 끝내지 마라")만으로는 모델이 자꾸 어겨서,
  // JSON으로 translation/correction/reply를 분리해 받아 포맷은 우리 코드가 직접 조립한다.
  // 대화 종료 후 한꺼번에 피드백을 만드는 대신, 매 턴마다 바로 짚어준다 — 더 빠르고 자연스럽다.
  // (이 지시문은 매 요청마다 다시 보내는 입력 토큰이라, 짧게 유지해 무료 한도를 아낀다.)
  const hintNote =
    'Reply as JSON: {translation, correction, noteKo, reply} (all strings). ' +
    'Korean input -> fill "translation" with the natural English phrase (no quotes/labels), "correction" "". ' +
    'English input with a real mistake -> fill "correction" with the natural fix, "translation" "". ' +
    'English input already fine -> leave both "". ' +
    '"noteKo": one short Korean sentence, only when translation/correction is set, else "". ' +
    '"reply": ALWAYS a non-empty in-character line that reacts and moves the scene forward — never empty, never just restating translation/correction.';
  const systemPrompt =
    `${scenario.systemPrompt} Your opening line to the user was: "${scenario.startLine}". ` +
    `Continue the conversation naturally from there. Keep "reply" to at most ${settings.maxSentences} sentence(s). ` +
    `Use ${settings.vocab}. ${settings.guidance} ${hintNote}`;

  const data = await callGeminiApi({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    // Gemini는 AI 턴의 role을 "model"로 쓴다(Claude의 "assistant"와 다름).
    contents: turns.map((m) => ({
      role: m.speaker === "user" ? "user" : "model",
      parts: [{ text: m.text }],
    })),
    generationConfig: { maxOutputTokens: 300, responseMimeType: "application/json" },
  });

  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) throw new Error("빈 응답을 받았습니다.");

  const cleaned = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // JSON 모드인데도 깨진 형식이 오면, 대화가 끊기지 않도록 평문 그대로를 답변으로 쓴다.
    return { text: cleaned, correction: null };
  }

  const reply = (parsed.reply || "").trim();
  if (!reply) throw new Error("빈 응답을 받았습니다.");

  const translation = (parsed.translation || "").trim();
  const correction = (parsed.correction || "").trim();
  const noteKo = (parsed.noteKo || "").trim();
  const lastUserText = turns[turns.length - 1]?.text || "";

  if (translation) {
    return { text: `"${translation}"\n\n${reply}`, correction: null };
  }
  if (correction) {
    return {
      text: `"${correction}"\n\n${reply}`,
      correction: { original: lastUserText, suggestion: correction, noteKo },
    };
  }
  return { text: reply, correction: null };
}

// ---------------------------------------------------------------------------
// 음성 출력 (TTS) — AI 응답은 항상 영어이므로 lang을 en-US로 고정한다
// ---------------------------------------------------------------------------

function speakText(text, rate = 1) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // 이전에 재생 중이던 발화가 있으면 정리
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

// ---------------------------------------------------------------------------
// 음성 입력 (STT) — 사용자가 선택한 언어(한국어/영어)로 인식한다
// ---------------------------------------------------------------------------

let inputLang = "ko-KR";
let recognition = null;
let isListening = false;
let micSupported = false;

function setMicStatus(text) {
  const el = document.getElementById("mic-status");
  if (el) el.textContent = text;
}

function setupSpeechInput() {
  const micBtn = document.getElementById("btn-mic");
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!RecognitionCtor) {
    micSupported = false;
    micBtn.disabled = true;
    micBtn.title = "이 브라우저는 음성 인식을 지원하지 않습니다. 텍스트 입력을 사용하세요.";
    setMicStatus("이 브라우저는 음성 인식을 지원하지 않습니다. 최신 Chrome을 권장합니다.");
    return;
  }

  micSupported = true;

  micBtn.addEventListener("click", () => {
    if (isListening) {
      recognition && recognition.stop();
      return;
    }
    startListening(RecognitionCtor);
  });

  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputLang = btn.dataset.lang;
      document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
}

function startListening(RecognitionCtor) {
  recognition = new RecognitionCtor();
  recognition.lang = inputLang;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  const micBtn = document.getElementById("btn-mic");

  recognition.onstart = () => {
    isListening = true;
    micBtn.classList.add("listening");
    micBtn.textContent = "🎤 듣는 중... (클릭 시 중지)";
    setMicStatus("");
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    if (!transcript) return;
    const session = getCurrentSession();
    if (session) handleUserTurn(session, transcript);
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      setMicStatus("마이크 권한이 필요합니다. 브라우저 주소창 옆 설정에서 허용해주세요.");
    } else if (event.error === "no-speech") {
      setMicStatus("음성이 감지되지 않았습니다. 다시 시도해주세요.");
    } else {
      setMicStatus(`음성 인식 오류: ${event.error}`);
    }
  };

  recognition.onend = () => {
    isListening = false;
    micBtn.classList.remove("listening");
    micBtn.textContent = "🎤 말하기";
  };

  recognition.start();
}

function endSession(session) {
  session.status = "ended";
  session.endedAt = new Date().toISOString();
  state.currentSessionId = null;
  saveState();

  recognition && recognition.stop(); // 듣는 중이었다면 멈춘다
  setTyping(false); // 응답을 기다리던 중이었다면 잠금을 풀어, 다음 세션 입력이 막히지 않게 한다
  setInputEnabled(true);

  showScreen("feedback");
  generateFeedback(session);
}

// ---------------------------------------------------------------------------
// 교정 피드백 생성·저장·표시
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// 대화 종료 후 따로 긴 API 호출을 또 하지 않는다 — 교정은 이미 대화 중에
// (callGemini의 correction 필드로) 실시간으로 다 모아뒀으므로, 그걸 그대로 정리해서
// 보여주기만 하면 된다. 그래서 이 화면은 기다릴 필요 없이 바로 뜬다.
function generateFeedback(session) {
  const corrections = session.corrections || [];
  const summary =
    corrections.length === 0
      ? "이번 대화에서는 특별히 고칠 표현이 없었어요. 아주 자연스러웠어요! 🎉"
      : `이번 대화에서 다듬으면 좋을 표현을 ${corrections.length}개 짚어봤어요.`;

  const feedback = { summary, highlights: corrections };
  saveFeedback(session, feedback);
  renderFeedback(feedback);
}

function saveFeedback(session, feedback) {
  state.feedbackHistory.push({
    sessionId: session.id,
    summary: feedback.summary,
    highlights: feedback.highlights,
    createdAt: new Date().toISOString(),
  });
  saveState();
}

function renderFeedback(feedback) {
  const list = document.getElementById("feedback-list");
  list.innerHTML = "";

  const summaryCard = document.createElement("div");
  summaryCard.className = "feedback-item feedback-summary";
  summaryCard.textContent = feedback.summary;
  list.appendChild(summaryCard);

  feedback.highlights.forEach((item) => {
    const card = document.createElement("div");
    card.className = "feedback-item";
    card.innerHTML = `
      <div class="feedback-original">"${escapeHtml(item.original)}"</div>
      <div class="feedback-row"><span class="feedback-label">이렇게 말해보세요</span>${escapeHtml(item.suggestion)}</div>
      <div class="feedback-explain">${escapeHtml(item.noteKo || "")}</div>
    `;
    list.appendChild(card);
  });
}

function restart() {
  state.currentSessionId = null;
  saveState();
  showScreen("scenario");
}

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------

function init() {
  renderScenarios();
  setupSpeechInput();
  setupApiKeyUI();

  const current = getCurrentSession();
  if (current && current.status === "active") {
    // 새로고침해도 진행 중이던 대화로 돌아온다.
    openConversationScreen(current);
  } else {
    showScreen("scenario");
  }

  document.getElementById("btn-end").addEventListener("click", () => {
    const session = getCurrentSession();
    if (session) endSession(session);
  });

  document.getElementById("form-text-input").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("input-text");
    const text = input.value.trim();
    if (!text) return;

    const session = getCurrentSession();
    if (session) handleUserTurn(session, text);
    input.value = "";
  });

  document.getElementById("btn-restart").addEventListener("click", restart);
}

document.addEventListener("DOMContentLoaded", init);
