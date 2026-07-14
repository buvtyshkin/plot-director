// ============================================================
//  Plot Director — SillyTavern Extension v1.0
//  A plot controller with step-by-step narrative injection.
//  Uses import * for maximum compatibility across ST versions.
// ============================================================

import * as ExtModule from "../../../extensions.js";
import * as ScriptModule from "../../../../script.js";

// ── Extract what's available from modules ────────────────────
const extension_settings = ExtModule.extension_settings;
const getContext = ExtModule.getContext;

// These may or may not exist as direct exports — we'll patch from context
let setExtensionPrompt = ExtModule.setExtensionPrompt;
let eventSource = ScriptModule.eventSource;
let event_types = ScriptModule.event_types;
let generateQuietPrompt = ScriptModule.generateQuietPrompt;
let saveChatDebounced = ScriptModule.saveChatDebounced;

// ── Constants ────────────────────────────────────────────────

const EXT_NAME = "plot-director";
const INJECTION_ID = "plot_director_injection";
const MARKER_RE = /\[step\s+(\d+)\s+complete\]/gi;
const STEP_PARSE_RE = /\[STEP\s+(\d+)\]\s*:\s*([\s\S]+?)(?=\n\s*\[STEP\s+\d+\]|$)/gi;

const TIMESPANS = {
    scene:   "одна сцена / one scene",
    day:     "один день / one day",
    week:    "одна неделя / one week",
    month:   "один месяц / one month",
    year:    "один год / one year",
    decade:  "десятилетие / a decade",
};

const LANGUAGES = {
    ko: "한국어 (Korean)",
    ja: "日本語 (Japanese)",
    zh: "中文 (Chinese)",
    ar: "العربية (Arabic)",
    hi: "हिन्दी (Hindi)",
    th: "ภาษาไทย (Thai)",
    en: "English",
    ru: "Русский",
};

const GENRES = {
    drama:     "Drama",
    thriller:  "Thriller",
    romance:   "Romance",
    mystery:   "Mystery",
    adventure: "Adventure",
    horror:    "Horror",
    comedy:    "Comedy",
    scifi:     "Sci-Fi",
    fantasy:   "Fantasy",
    slice:     "Slice of Life",
};

const DEFAULT_SETTINGS = {
    enabled: true,
    autoRegenTail: false,
    defaultStepCount: 8,
    defaultTimespan: "month",
    defaultLanguage: "ko",
    defaultEpicness: 5,
    defaultRealism: 5,
    defaultGenre: "drama",
};

// ── Patch missing functions from context ─────────────────────

function patchFromContext() {
    if (!getContext) {
        console.error("[Plot Director] getContext not available — extension cannot function.");
        return false;
    }
    const ctx = getContext();
    if (!setExtensionPrompt) setExtensionPrompt = ctx.setExtensionPrompt;
    if (!eventSource) eventSource = ctx.eventSource;
    if (!event_types) event_types = ctx.event_types;
    if (!generateQuietPrompt) generateQuietPrompt = ctx.generateQuietPrompt;
    if (!saveChatDebounced) saveChatDebounced = ctx.saveChatDebounced || ctx.saveChat;

    const missing = [];
    if (!setExtensionPrompt) missing.push("setExtensionPrompt");
    if (!eventSource) missing.push("eventSource");
    if (!event_types) missing.push("event_types");
    if (!generateQuietPrompt) missing.push("generateQuietPrompt");
    if (!saveChatDebounced) missing.push("saveChatDebounced");

    if (missing.length) {
        console.warn("[Plot Director] Still missing after patching:", missing.join(", "));
    } else {
        console.log("[Plot Director] All functions resolved.");
    }
    return true;
}

// ── Plot Data Helpers ────────────────────────────────────────
// Module-level cache — guarantees data survives getContext() inconsistencies
let _plotCache = {};

function _chatId() {
    const ctx = getContext();
    return ctx?.chatId || "default";
}

function getPlotData() {
    const id = _chatId();
    // Module cache first (always reliable)
    if (_plotCache[id]) return _plotCache[id];
    // Try loading from chat_metadata
    const ctx = getContext();
    const stored = ctx?.chat_metadata?.plot_director;
    if (stored) {
        _plotCache[id] = stored;
        return stored;
    }
    return null;
}

function savePlotData(data) {
    const id = _chatId();
    // Save to module cache
    _plotCache[id] = data;
    // Also persist to chat_metadata for cross-session storage
    try {
        const ctx = getContext();
        if (!ctx.chat_metadata) ctx.chat_metadata = {};
        ctx.chat_metadata.plot_director = data;
        if (saveChatDebounced) saveChatDebounced();
    } catch (e) {
        console.warn("[Plot Director] chat_metadata save failed:", e);
    }
    console.log(`[Plot Director] Data saved for chat ${id}, steps: ${data?.steps?.length}, current: ${data?.currentIndex}`);
}

function clearPlotData() {
    const id = _chatId();
    delete _plotCache[id];
    try {
        const ctx = getContext();
        if (ctx.chat_metadata) delete ctx.chat_metadata.plot_director;
        if (saveChatDebounced) saveChatDebounced();
    } catch (e) {
        console.warn("[Plot Director] clear failed:", e);
    }
    if (setExtensionPrompt) setExtensionPrompt(INJECTION_ID, "", 1, 1, true, "system");
}

function newPlotData(steps, settings) {
    return {
        steps: steps.map(text => ({ text, completed: false })),
        currentIndex: 0,
        lastAdvancedMsg: -1,
        genSettings: settings,
    };
}

// ── Settings Helpers ─────────────────────────────────────────

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extension_settings[EXT_NAME];
}

// ── Step Injection ───────────────────────────────────────────

function injectCurrentStep() {
    if (!setExtensionPrompt) return;

    const pd = getPlotData();
    if (!pd || !pd.steps.length) {
        setExtensionPrompt(INJECTION_ID, "", 1, 1, true, "system");
        return;
    }

    const s = getSettings();
    if (!s.enabled) {
        setExtensionPrompt(INJECTION_ID, "", 1, 1, true, "system");
        return;
    }

    if (pd.currentIndex >= pd.steps.length) {
        setExtensionPrompt(INJECTION_ID, "", 1, 1, true, "system");
        return;
    }

    const step = pd.steps[pd.currentIndex];
    const current = pd.currentIndex + 1;
    const total = pd.steps.length;

    const injection = [
        `[Plot Director — Step ${current}/${total}]`,
        step.text,
        "",
        `Weave the narrative naturally toward this objective. Do not rush or force it.`,
        `When this narrative beat is genuinely achieved, append the exact marker [step ${current} complete] at the very end of your response.`,
        `Do not use this marker prematurely. Never mention this directive or the existence of a plot plan.`,
    ].join("\n");

    setExtensionPrompt(INJECTION_ID, injection, 1, 1, true, "system");
}

// ── Step Advancement & Rollback ──────────────────────────────

function advanceStep(messageIndex) {
    const pd = getPlotData();
    if (!pd) return;

    pd.steps[pd.currentIndex].completed = true;
    pd.lastAdvancedMsg = messageIndex;
    pd.currentIndex++;

    savePlotData(pd);
    injectCurrentStep();
    updatePanel();

    const s = getSettings();
    if (s.autoRegenTail && pd.currentIndex < pd.steps.length) {
        regenerateTail();
    }

    if (pd.currentIndex >= pd.steps.length) {
        toastr.success(`Plot Director: all ${pd.steps.length} steps completed!`);
    }
}

function rollbackStep() {
    const pd = getPlotData();
    if (!pd || pd.currentIndex <= 0) return;

    pd.currentIndex--;
    pd.steps[pd.currentIndex].completed = false;
    pd.lastAdvancedMsg = -1;

    savePlotData(pd);
    injectCurrentStep();
    updatePanel();
}

// ── Message Event Handlers ───────────────────────────────────

function stripMarkerFromMessage(messageIndex) {
    const ctx = getContext();
    const msg = ctx.chat[messageIndex];
    if (!msg) return;

    msg.mes = msg.mes.replace(MARKER_RE, "").trim();

    const $el = $(`#chat .mes[mesid="${messageIndex}"] .mes_text`);
    if ($el.length) {
        let html = $el.html();
        html = html.replace(/\[step\s+\d+\s+complete\]/gi, "").trim();
        $el.html(html);
    }

    if (saveChatDebounced) saveChatDebounced();
}

function onMessageReceived(messageIndex) {
    const s = getSettings();
    if (!s.enabled) return;

    const pd = getPlotData();
    if (!pd || !pd.steps.length || pd.currentIndex >= pd.steps.length) return;

    const ctx = getContext();
    const idx = (typeof messageIndex === "number") ? messageIndex : ctx.chat.length - 1;
    const msg = ctx.chat[idx];
    if (!msg || msg.is_user) return;

    const expectedStep = pd.currentIndex + 1;
    const re = new RegExp(`\\[step\\s+${expectedStep}\\s+complete\\]`, "gi");

    if (re.test(msg.mes)) {
        stripMarkerFromMessage(idx);
        advanceStep(idx);
    }
}

function onMessageSwiped(messageIndex) {
    const s = getSettings();
    if (!s.enabled) return;

    const pd = getPlotData();
    if (!pd || !pd.steps.length) return;

    const ctx = getContext();
    const idx = (typeof messageIndex === "number") ? messageIndex : ctx.chat.length - 1;

    if (pd.lastAdvancedMsg === idx) {
        const msg = ctx.chat[idx];
        if (!msg) return;

        const expectedStep = pd.currentIndex;
        const re = new RegExp(`\\[step\\s+${expectedStep}\\s+complete\\]`, "gi");

        if (!re.test(msg.mes)) {
            rollbackStep();
            toastr.info("Plot Director: step rolled back (marker absent in swipe).");
        } else {
            stripMarkerFromMessage(idx);
        }
    } else {
        onMessageReceived(idx);
    }
}

function onChatChanged() {
    // Force reload from chat_metadata into cache on chat switch
    const id = _chatId();
    try {
        const ctx = getContext();
        const stored = ctx?.chat_metadata?.plot_director;
        if (stored) {
            _plotCache[id] = stored;
        } else {
            delete _plotCache[id];
        }
    } catch (e) { /* ignore */ }

    const pd = getPlotData();
    if (pd && pd.steps.length > 0) {
        injectCurrentStep();
    } else if (setExtensionPrompt) {
        setExtensionPrompt(INJECTION_ID, "", 1, 1, true, "system");
    }
    updatePanel();
}

// ── Plot Generation ──────────────────────────────────────────

function buildGenerationPrompt(opts) {
    const langName = LANGUAGES[opts.language] || opts.language;
    const timespanLabel = TIMESPANS[opts.timespan] || opts.timespan;

    let prompt = [
        `[OOC: PLOT GENERATION REQUEST — This is a meta-request outside the roleplay. Do not respond in character.`,
        `Act as a master plot architect.`,
        ``,
        `Based on the full narrative context — the story so far, all character profiles, world lore, and the current situation — create a structured plot outline.`,
        ``,
        `Parameters:`,
        `• Number of steps: ${opts.stepCount}`,
        `• Time span covered by the plot: ${timespanLabel}`,
        `• Genre emphasis: ${GENRES[opts.genre] || opts.genre}`,
        `• Epicness: ${opts.epicness}/10 (1 = quiet/intimate, 10 = earth-shattering)`,
        `• Realism: ${opts.realism}/10 (1 = fantastical, 10 = grounded)`,
    ];

    if (opts.customDirection && opts.customDirection.trim()) {
        prompt.push(``, `Additional direction from the author:`, opts.customDirection.trim());
    }

    prompt.push(
        ``,
        `CRITICAL: Write ALL step descriptions ONLY in ${langName}. This is mandatory.`,
        ``,
        `Output EXACTLY ${opts.stepCount} steps in this EXACT format, one per block:`,
        `[STEP 1]: (2-4 sentence description in ${langName})`,
        `[STEP 2]: (2-4 sentence description in ${langName})`,
        `...and so on up to [STEP ${opts.stepCount}]`,
        ``,
        `Rules:`,
        `- Each step is a specific narrative beat or turning point.`,
        `- Steps flow from the current story state and build on each other.`,
        `- Include specific character actions, events, or revelations.`,
        `- No meta-references to this outline.`,
        `- Output ONLY the steps. No preamble, no commentary, no markdown.]`,
    );

    return prompt.join("\n");
}

function parseSteps(text) {
    const steps = [];
    let match;
    const re = new RegExp(STEP_PARSE_RE.source, STEP_PARSE_RE.flags);
    while ((match = re.exec(text)) !== null) {
        steps.push(match[2].trim());
    }
    return steps;
}

async function generatePlot(opts) {
    if (!generateQuietPrompt) {
        toastr.error("Plot Director: generateQuietPrompt not available.");
        return null;
    }

    const prompt = buildGenerationPrompt(opts);
    try {
        const result = await generateQuietPrompt(prompt, false);
        if (!result) throw new Error("Empty response from API");

        const steps = parseSteps(result);
        if (steps.length === 0) {
            const lines = result.split(/\n/).filter(l => l.trim());
            if (lines.length > 0) {
                lines.forEach(l => {
                    const cleaned = l.replace(/^\[?STEP\s*\d+\]?\s*:?\s*/i, "").trim();
                    if (cleaned) steps.push(cleaned);
                });
            }
        }

        if (steps.length === 0) {
            throw new Error("Could not parse steps from API response");
        }

        const pd = newPlotData(steps, opts);
        savePlotData(pd);
        injectCurrentStep();
        updatePanel();

        toastr.success(`Plot Director: generated ${steps.length} steps.`);
        return steps;
    } catch (err) {
        toastr.error(`Plot Director error: ${err.message}`);
        console.error("[Plot Director] Generation error:", err);
        return null;
    }
}

async function regenerateTail() {
    const pd = getPlotData();
    if (!pd || pd.currentIndex >= pd.steps.length) return;

    if (!generateQuietPrompt) {
        toastr.error("Plot Director: generateQuietPrompt not available.");
        return;
    }

    const completedSteps = pd.steps
        .slice(0, pd.currentIndex)
        .map((s, i) => `[STEP ${i + 1}]: ${s.text}`)
        .join("\n");

    const remainingCount = pd.steps.length - pd.currentIndex;
    const opts = pd.genSettings || {};
    const langName = LANGUAGES[opts.language || "ko"] || "Korean";

    const prompt = [
        `[OOC: PLOT REGENERATION REQUEST — Meta-request outside the roleplay.`,
        `You are a plot architect. The story has progressed through these completed steps:`,
        ``,
        completedSteps,
        ``,
        `Based on how the story has ACTUALLY developed (which may differ from the original plan),`,
        `generate ${remainingCount} NEW steps to continue the plot from this point.`,
        `Maintain the same genre (${GENRES[opts.genre] || "Drama"}) and tone.`,
        `Write ALL step descriptions ONLY in ${langName}.`,
        ``,
        `Output format:`,
        ...Array.from({ length: remainingCount }, (_, i) =>
            `[STEP ${pd.currentIndex + i + 1}]: (description in ${langName})`
        ),
        ``,
        `No preamble, no commentary.]`,
    ].join("\n");

    try {
        const result = await generateQuietPrompt(prompt, false);
        if (!result) throw new Error("Empty response");

        const newSteps = parseSteps(result);
        if (newSteps.length === 0) {
            throw new Error("Could not parse regenerated steps");
        }

        const kept = pd.steps.slice(0, pd.currentIndex);
        const fresh = newSteps.map(text => ({ text, completed: false }));
        pd.steps = [...kept, ...fresh];

        savePlotData(pd);
        injectCurrentStep();
        updatePanel();

        toastr.success(`Plot Director: regenerated ${newSteps.length} remaining steps.`);
    } catch (err) {
        toastr.error(`Plot Director regen error: ${err.message}`);
        console.error("[Plot Director] Regen error:", err);
    }
}

// ── UI: Extensions Panel ─────────────────────────────────────

function buildPanelHTML() {
    return `
    <div id="plot_director_panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎬 Plot Director</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="pd-status" id="pd_status">
                    <span class="pd-status-dot inactive" id="pd_status_dot"></span>
                    <span id="pd_status_text">No active plot</span>
                </div>
                <div class="pd-btn-row">
                    <div class="menu_button" id="pd_btn_generate" title="Generate new plot">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> New
                    </div>
                    <div class="menu_button" id="pd_btn_steps" title="Manage steps">
                        <i class="fa-solid fa-list-ol"></i> Steps
                    </div>
                    <div class="menu_button" id="pd_btn_regen" title="Regenerate remaining steps">
                        <i class="fa-solid fa-rotate"></i> Regen
                    </div>
                </div>
                <div class="pd-btn-row">
                    <div class="menu_button" id="pd_btn_prev" title="Previous step">
                        <i class="fa-solid fa-backward-step"></i>
                    </div>
                    <div class="menu_button" id="pd_btn_next" title="Next step">
                        <i class="fa-solid fa-forward-step"></i>
                    </div>
                    <div class="menu_button" id="pd_btn_clear" title="Clear plot">
                        <i class="fa-solid fa-trash-can"></i> Clear
                    </div>
                </div>
                <hr class="pd-divider">
                <div class="pd-toggle-row">
                    <input type="checkbox" id="pd_toggle_enabled">
                    <label for="pd_toggle_enabled">Injection active</label>
                </div>
                <div class="pd-toggle-row">
                    <input type="checkbox" id="pd_toggle_autoregen">
                    <label for="pd_toggle_autoregen">Auto-regenerate tail</label>
                </div>
            </div>
        </div>
    </div>`;
}

function updatePanel() {
    const pd = getPlotData();
    const s = getSettings();

    const $dot = $("#pd_status_dot");
    const $txt = $("#pd_status_text");
    const $en = $("#pd_toggle_enabled");
    const $ar = $("#pd_toggle_autoregen");

    $en.prop("checked", s.enabled);
    $ar.prop("checked", s.autoRegenTail);

    if (!pd || !pd.steps || pd.steps.length === 0) {
        $dot.removeClass("active complete").addClass("inactive");
        $txt.text("No active plot");
    } else if (pd.currentIndex >= pd.steps.length) {
        $dot.removeClass("active inactive").addClass("complete");
        $txt.text(`✓ All ${pd.steps.length} steps complete`);
    } else {
        $dot.removeClass("inactive complete").addClass("active");
        $txt.text(`Step ${pd.currentIndex + 1} / ${pd.steps.length}`);
    }
}

// ── UI: Generate Modal ───────────────────────────────────────

function buildOptionTags(map, selected) {
    return Object.entries(map)
        .map(([k, v]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${v}</option>`)
        .join("");
}

function showGenerateModal() {
    const s = getSettings();

    const html = `
    <div class="pd-modal-overlay" id="pd_generate_overlay">
        <div class="pd-modal">
            <div class="pd-modal-header">
                <span>🎬 Generate New Plot</span>
                <button class="pd-modal-close" id="pd_gen_close">&times;</button>
            </div>
            <div class="pd-modal-body">
                <div class="pd-field">
                    <label>Number of steps</label>
                    <div class="pd-range-row">
                        <input type="range" id="pd_gen_count" min="2" max="20" value="${s.defaultStepCount}">
                        <span class="pd-range-val" id="pd_gen_count_val">${s.defaultStepCount}</span>
                    </div>
                </div>
                <div class="pd-field">
                    <label>Time span</label>
                    <select id="pd_gen_timespan">${buildOptionTags(TIMESPANS, s.defaultTimespan)}</select>
                </div>
                <div class="pd-field">
                    <label>Anti-spoiler language</label>
                    <select id="pd_gen_lang">${buildOptionTags(LANGUAGES, s.defaultLanguage)}</select>
                </div>
                <div class="pd-field">
                    <label>Genre</label>
                    <select id="pd_gen_genre">${buildOptionTags(GENRES, s.defaultGenre)}</select>
                </div>
                <div class="pd-field">
                    <label>Epicness</label>
                    <div class="pd-range-row">
                        <input type="range" id="pd_gen_epic" min="1" max="10" value="${s.defaultEpicness}">
                        <span class="pd-range-val" id="pd_gen_epic_val">${s.defaultEpicness}</span>
                    </div>
                </div>
                <div class="pd-field">
                    <label>Realism</label>
                    <div class="pd-range-row">
                        <input type="range" id="pd_gen_real" min="1" max="10" value="${s.defaultRealism}">
                        <span class="pd-range-val" id="pd_gen_real_val">${s.defaultRealism}</span>
                    </div>
                </div>
                <div class="pd-field">
                    <label>Custom direction (optional)</label>
                    <textarea id="pd_gen_custom" placeholder="e.g. Focus on the relationship between Nick and Eva. Build toward a confrontation at the embassy."></textarea>
                </div>
                <p class="pd-note">Generation uses the current chat context, lorebook, character cards, and persona.</p>
            </div>
            <div class="pd-modal-footer">
                <div class="menu_button" id="pd_gen_cancel">Cancel</div>
                <div class="menu_button" id="pd_gen_submit" style="font-weight:600;">
                    <i class="fa-solid fa-wand-magic-sparkles"></i> Generate
                </div>
            </div>
        </div>
    </div>`;

    $("body").append(html);

    $("#pd_gen_count").on("input", function () { $("#pd_gen_count_val").text(this.value); });
    $("#pd_gen_epic").on("input", function () { $("#pd_gen_epic_val").text(this.value); });
    $("#pd_gen_real").on("input", function () { $("#pd_gen_real_val").text(this.value); });

    const closeModal = () => $("#pd_generate_overlay").remove();
    $("#pd_gen_close, #pd_gen_cancel").on("click", closeModal);
    $("#pd_generate_overlay").on("click", function (e) {
        if (e.target === this) closeModal();
    });

    $("#pd_gen_submit").on("click", async function () {
        const opts = {
            stepCount:   parseInt($("#pd_gen_count").val()),
            timespan:    $("#pd_gen_timespan").val(),
            language:    $("#pd_gen_lang").val(),
            genre:       $("#pd_gen_genre").val(),
            epicness:    parseInt($("#pd_gen_epic").val()),
            realism:     parseInt($("#pd_gen_real").val()),
            customDirection: $("#pd_gen_custom").val(),
        };

        const s = getSettings();
        s.defaultStepCount = opts.stepCount;
        s.defaultTimespan  = opts.timespan;
        s.defaultLanguage  = opts.language;
        s.defaultGenre     = opts.genre;
        s.defaultEpicness  = opts.epicness;
        s.defaultRealism   = opts.realism;

        $(".pd-modal-body").html(`
            <div class="pd-loading">
                <div class="pd-spinner"></div>
                <div class="pd-loading-text">Generating plot…</div>
            </div>
        `);
        $(".pd-modal-footer").hide();

        const result = await generatePlot(opts);

        if (result) {
            closeModal();
        } else {
            closeModal();
            showGenerateModal();
        }
    });
}

// ── UI: Steps Management Modal ───────────────────────────────

function showStepsModal() {
    const pd = getPlotData();

    if (!pd || !pd.steps.length) {
        toastr.warning("No active plot. Generate one first.");
        return;
    }

    const lang = pd.genSettings?.language || "ko";
    const isForeignLang = !["en", "ru"].includes(lang);

    const stepsHTML = pd.steps.map((step, i) => {
        let status;
        if (step.completed) {
            status = "completed";
        } else if (i === pd.currentIndex) {
            status = "active";
        } else {
            status = "pending";
        }

        const spoilerClass = isForeignLang ? "" : "spoiler-blur";

        return `
        <li class="pd-step-item ${status}" data-step-index="${i}">
            <div class="pd-step-badge ${status}">${i + 1}</div>
            <div class="pd-step-content">
                <div class="pd-step-text ${spoilerClass}" data-step-index="${i}">${escapeHtml(step.text)}</div>
            </div>
            <div class="pd-step-actions">
                <button class="pd-step-edit-btn" data-step-index="${i}" title="Edit">✎</button>
                <button class="pd-step-goto-btn" data-step-index="${i}" title="Go to this step">→</button>
            </div>
        </li>`;
    }).join("");

    const html = `
    <div class="pd-modal-overlay" id="pd_steps_overlay">
        <div class="pd-modal">
            <div class="pd-modal-header">
                <span>📋 Plot Steps (${pd.currentIndex + 1}/${pd.steps.length})</span>
                <button class="pd-modal-close" id="pd_steps_close">&times;</button>
            </div>
            <div class="pd-modal-body">
                ${!isForeignLang ? '<p class="pd-note">Click blurred text to reveal/hide.</p>' : ""}
                <ul class="pd-step-list">${stepsHTML}</ul>
            </div>
            <div class="pd-modal-footer">
                <div class="menu_button" id="pd_steps_reveal_all">
                    <i class="fa-solid fa-eye"></i> Toggle All
                </div>
                <div class="menu_button" id="pd_steps_done">Close</div>
            </div>
        </div>
    </div>`;

    $("body").append(html);

    const closeModal = () => $("#pd_steps_overlay").remove();
    $("#pd_steps_close, #pd_steps_done").on("click", closeModal);
    $("#pd_steps_overlay").on("click", function (e) {
        if (e.target === this) closeModal();
    });

    $(".pd-step-text.spoiler-blur").on("click", function () {
        $(this).toggleClass("revealed");
    });

    $("#pd_steps_reveal_all").on("click", function () {
        const $blurred = $(".pd-step-text.spoiler-blur");
        const anyHidden = $blurred.not(".revealed").length > 0;
        $blurred.toggleClass("revealed", anyHidden);
    });

    $(".pd-step-edit-btn").on("click", function () {
        const idx = parseInt($(this).data("step-index"));
        const $content = $(this).closest(".pd-step-item").find(".pd-step-content");
        const $text = $content.find(".pd-step-text");

        if ($content.find(".pd-step-edit-area").length) return;

        const currentText = pd.steps[idx].text;
        $text.hide();
        $content.append(`
            <textarea class="pd-step-edit-area" data-step-index="${idx}">${escapeHtml(currentText)}</textarea>
            <div style="display:flex;gap:4px;margin-top:4px;">
                <button class="pd-step-save-btn menu_button" data-step-index="${idx}" style="font-size:0.8em;padding:2px 8px;">Save</button>
                <button class="pd-step-cancel-btn" data-step-index="${idx}" style="font-size:0.8em;padding:2px 8px;background:none;border:1px solid rgba(255,255,255,0.15);color:inherit;border-radius:3px;cursor:pointer;">Cancel</button>
            </div>
        `);

        $content.find(".pd-step-save-btn").on("click", function () {
            const newText = $content.find(".pd-step-edit-area").val().trim();
            if (newText) {
                pd.steps[idx].text = newText;
                savePlotData(pd);
                if (idx === pd.currentIndex) injectCurrentStep();
            }
            closeModal();
            showStepsModal();
        });

        $content.find(".pd-step-cancel-btn").on("click", function () {
            $content.find(".pd-step-edit-area, div:last-child").remove();
            $text.show();
        });
    });

    $(".pd-step-goto-btn").on("click", function () {
        const idx = parseInt($(this).data("step-index"));
        const pd2 = getPlotData();
        if (!pd2) return;

        pd2.steps.forEach((s, i) => { s.completed = i < idx; });
        pd2.currentIndex = idx;
        pd2.lastAdvancedMsg = -1;

        savePlotData(pd2);
        injectCurrentStep();
        updatePanel();

        closeModal();
        showStepsModal();
        toastr.info(`Plot Director: jumped to step ${idx + 1}.`);
    });
}

// ── Utility ──────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ── Initialization ───────────────────────────────────────────

jQuery(async () => {
    // Patch missing functions from context
    if (!patchFromContext()) return;

    // Ensure settings exist
    getSettings();

    // Inject panel
    const $container = $("#extensions_settings2");
    $container.append(buildPanelHTML());

    // Panel button handlers
    $("#pd_btn_generate").on("click", () => {
        const pd = getPlotData();
        if (pd && pd.steps.length > 0) {
            if (!confirm("This will replace the existing plot. Continue?")) return;
        }
        showGenerateModal();
    });

    $("#pd_btn_steps").on("click", showStepsModal);

    $("#pd_btn_regen").on("click", async () => {
        const pd = getPlotData();
        if (!pd || !pd.steps.length) {
            toastr.warning("No active plot.");
            return;
        }
        if (pd.currentIndex >= pd.steps.length) {
            toastr.warning("All steps already completed.");
            return;
        }
        toastr.info("Regenerating remaining steps…");
        await regenerateTail();
    });

    $("#pd_btn_prev").on("click", () => {
        const pd = getPlotData();
        if (!pd || pd.currentIndex <= 0) {
            toastr.warning("Already at step 1.");
            return;
        }
        rollbackStep();
        toastr.info(`Rolled back to step ${getPlotData().currentIndex + 1}.`);
    });

    $("#pd_btn_next").on("click", () => {
        const pd = getPlotData();
        if (!pd || !pd.steps.length) {
            toastr.warning("No active plot.");
            return;
        }
        if (pd.currentIndex >= pd.steps.length) {
            toastr.warning("All steps completed.");
            return;
        }
        advanceStep(-1);
    });

    $("#pd_btn_clear").on("click", () => {
        if (!confirm("Clear the current plot? This cannot be undone.")) return;
        clearPlotData();
        updatePanel();
        toastr.info("Plot Director: plot cleared.");
    });

    $("#pd_toggle_enabled").on("change", function () {
        const s = getSettings();
        s.enabled = this.checked;
        injectCurrentStep();
    });

    $("#pd_toggle_autoregen").on("change", function () {
        const s = getSettings();
        s.autoRegenTail = this.checked;
    });

    // Event listeners
    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => onMessageReceived(idx));
        eventSource.on(event_types.MESSAGE_SWIPED, (idx) => onMessageSwiped(idx));
        eventSource.on(event_types.CHAT_CHANGED, () => onChatChanged());
        console.log("[Plot Director] Event listeners registered.");
    } else {
        console.warn("[Plot Director] eventSource/event_types not available — auto-detection disabled.");
    }

    // Initial state
    onChatChanged();

    console.log("[Plot Director] Extension loaded successfully.");
});
