// --- Electron bridge (via contextBridge from preload.js) ---
const leanAPI = window.leanAPI || null;
const electronAvailable = Boolean(leanAPI?.invoke);

// Compatibility wrapper — delegates to the contextBridge-exposed leanAPI.
// With contextIsolation:true, the renderer cannot access Node/Electron APIs directly.
const ipcRenderer = electronAvailable ? {
  invoke: (...args) => leanAPI.invoke(...args),
  on: (channel, callback) => { leanAPI.on(channel, callback); },
  send: (...args) => leanAPI.send(...args),
  removeAllListeners: (channel) => { leanAPI.removeAllListeners(channel); }
} : null;

// --- Imports ---
import { normalizeRamMb, clampRamForSlider, applySoftRamSnap, normalizeRamGb, gbToMb, mbToGb, formatRamGb } from './lib/ram-utils.js';

// --- Debounce Utility ---
function debounce(fn, delayMs = 300) {
    let timer = null;
    const debounced = function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(this, args);
        }, delayMs);
    };
    debounced.flush = function () {
        if (timer) {
            clearTimeout(timer);
            timer = null;
            fn();
        }
    };
    debounced.cancel = function () {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    return debounced;
}

// --- DOM Elements ---
const layer = document.getElementById('bubbleLayer');
const launchGroup = document.querySelector('.launch-group'), statusBar = document.querySelector('.launch-status-bar'), statusText = document.getElementById('status-text'), statusProgress = document.getElementById('status-progress'), statusVersion = document.getElementById('status-version');
const versionSelect = document.getElementById('version-select'), launchProfileContainer = document.getElementById('launch-profile-container'), launchProfileSelect = document.getElementById('launch-profile-select');
const navLinks = document.querySelector('.nav-links'), navIndicator = document.getElementById('nav-indicator');
const PROFILE_ORDER = ['lightweight', 'balanced', 'full'];

const userSection = document.getElementById('user-section'), playerHead = document.getElementById('player-head'), usernameEl = document.getElementById('player-name'), leanDesc = document.getElementById('leanDesc');
const btnHome = document.getElementById('btn-home'), btnAbout = document.getElementById('btn-about'), btnInstances = document.getElementById('btn-instances'), btnSettings = document.getElementById('btn-settings'), homeView = document.getElementById('home-view'), aboutView = document.getElementById('about-view'), instancesView = document.getElementById('instances-view'), createVersionView = document.getElementById('create-version-view'), settingsView = document.getElementById('settings-view');

const globTheme = document.getElementById('global-theme'), globLang = document.getElementById('global-language'), globCloseOnBoot = document.getElementById('global-close-on-boot'), globSimpleMode = document.getElementById('global-simple-mode'), globShowFpsWarning = document.getElementById('global-show-fps-warning'), globAnimation = document.getElementById('global-animation');
const setInstanceSelect = document.getElementById('settings-instance-select'), setRam = document.getElementById('set-ram'), setRamSlider = document.getElementById('set-ram-slider'), ramRemainingText = document.getElementById('ram-remaining-text'), setPreset = document.getElementById('set-preset'), setJvm = document.getElementById('set-jvm'), setJavaPath = document.getElementById('set-javapath');
const toggleAdvancedBtn = document.getElementById('toggle-advanced'), advancedPanel = document.getElementById('advanced-settings-panel'), customArgsContainer = document.getElementById('custom-args-container'), playtimeText = document.getElementById('playtime-text'), playtimeTotalText = document.getElementById('playtime-text-total');
const cancelLaunchButton = document.getElementById('cancel-launch');
const instanceFilesOverlay = document.getElementById('instance-files-overlay'), instanceFilesTree = document.getElementById('instance-files-tree'), instanceFilesTitle = document.getElementById('instance-files-title'), closeInstanceFilesBtn = document.getElementById('btn-close-instance-files');
const uploadInstanceFilesBtn = document.getElementById('btn-upload-instance-files');
const confirmDeleteModal = document.getElementById('confirm-delete-modal'), confirmDeleteText = document.getElementById('confirm-delete-text'), confirmDeleteYes = document.getElementById('confirm-delete-yes'), confirmDeleteNo = document.getElementById('confirm-delete-no');
const fileEditorModal = document.getElementById('file-editor-modal'), fileEditorTitle = document.getElementById('file-editor-title'), fileEditorContent = document.getElementById('file-editor-content'), fileEditorSave = document.getElementById('file-editor-save'), fileEditorClose = document.getElementById('file-editor-close');
const crashReportModal = document.getElementById('crash-report-modal'), crashReportTitle = document.getElementById('crash-report-title'), crashReportMessage = document.getElementById('crash-report-message'), crashReportDetails = document.getElementById('crash-report-details'), crashReportClose = document.getElementById('crash-report-close');

const loginModal = document.getElementById('login-modal'), mainView = document.getElementById('login-main-view'), crackedView = document.getElementById('login-cracked-view'), manageView = document.getElementById('login-manage-view');
const loginAccountsList = document.getElementById('auth-accounts-list'), loginAccountsEmpty = document.getElementById('auth-accounts-empty');
const loginAddAccountButton = document.getElementById('login-now');
const crackedInput = document.getElementById('cracked-username');

const fpsWarningModal = document.getElementById('fps-warning-modal'), fpsWarningDontAsk = document.getElementById('fps-warning-dont-ask'), fpsWarningContinue = document.getElementById('fps-warning-continue');

const btnScreenshots = document.getElementById('btn-screenshots');
const screenshotsModal = document.getElementById('screenshots-modal'), screenshotsGrid = document.getElementById('screenshots-grid'), screenshotsClose = document.getElementById('screenshots-close'), screenshotsOpenFolder = document.getElementById('screenshots-open-folder');
const screenshotsVersionSelect = document.getElementById('screenshots-version-select');
const screenshotsSortNewest = document.getElementById('screenshots-sort-newest'), screenshotsSortOldest = document.getElementById('screenshots-sort-oldest');
const filterPillIndicator = document.getElementById('filter-pill-indicator');
const screenshotLightbox = document.getElementById('screenshot-lightbox'), screenshotLightboxImg = document.getElementById('screenshot-lightbox-img'), screenshotLightboxClose = document.getElementById('screenshot-lightbox-close'), screenshotLightboxCopy = document.getElementById('screenshot-lightbox-copy'), screenshotLightboxDelete = document.getElementById('screenshot-lightbox-delete');
const screenshotLightboxPrev = document.getElementById('screenshot-lightbox-prev'), screenshotLightboxNext = document.getElementById('screenshot-lightbox-next');
const screenshotLightboxName = document.getElementById('screenshot-lightbox-name'), screenshotLightboxDate = document.getElementById('screenshot-lightbox-date');

let isSignedIn = false;
let loginHideTimer = null;
let authAccountsState = { activeAccountId: null, accounts: [] };
const ACCOUNT_REMOVE_ANIM_MS = 240;
const ACCOUNT_PROMOTE_MOVE_MS = 180;
const ACCOUNT_PROMOTE_FRONT_MS = 90;
let versionFormMode = 'create';
let editingVersionName = null;
let editingFileState = null;
let currentInstanceFilesVersion = null;
let suppressFileEditorBackdropClick = false;
let totalSystemRamMb = null;
// Animation hooks — assigned inside initUI once canvas is ready
let startBubbles = () => {};
let stopBubbles = () => {};
let startRain = () => {};
let stopRain = () => {};
let applyAnimation = () => {};

const i18n = {
    en: {
        home: "Home", about: "About", instances: "Instances", settings: "Settings", launch: "LAUNCH", cancel: "Cancel", selectVer: "Select version",
        guest_ready: "Ready to play, Guest?", player_ready: "Ready to play, {name}?",
        lTitle: "Choose an account", lDesc: "Select a saved Microsoft account or add a new one.",
        msSign: "Add account", addAccount: "Add account", crSign: "Cracked Sign In", crTitle: "Cracked Username", crDesc: "Enter your display name to play cracked minecraft.",
        manageAccounts: "Manage Accounts", manageTitle: "Manage Accounts", manageDesc: "All saved accounts are listed below.",
        activeAccount: "Active", removeAccount: "Remove", noAccounts: "No saved Microsoft accounts yet.",
        login: "Log In", back: "Back", pref: "Preferences", lSet: "Launcher Settings",
        theme: "Theme", lang: "Language", closeOnBoot: "Close Launcher On Boot", simpleMode: "Simple Launcher", simpleModeDesc: "Disables animations and glass effects for better performance.", iSet: "Instance Settings",
        config: "Configuring:", play: "Playtime:", ram: "Allocated RAM", ramSub: "Amount of memory for this version.",
        adv: "Show Advanced Options ▼", advHide: "Hide Advanced Options ▲",
        jvm: "JVM Preset", jvmSub: "Garbage collection logic.", java: "Custom Java Path", javaSub: "Leave blank to use bundled Java.",
        aboutWhatLean: "What is Lean Launcher?",
        aboutWhatLeanText: "Lean Launcher is a highly optimized selection of mods for Minecraft Java Edition, played using Lean Launcher. It provides essential performance improvements while maintaining the vanilla feel of the game.",
        aboutWhatOld: "What is \"Lean Client Old\"?",
        aboutWhatOldText: "Lean Client Old is the first versions of Lean Launcher that I ever made. They use regular mods that are put into the instance. They are essentially modpacks.",
        aboutUploadTitle: "How can I upload my own version to use?",
        aboutUploadText: "To bring your own custom instance and files into the launcher, go to the Instances tab, click \"Create New Version,\" then set Instance Name, Version, Mod Loader, and Accent. After saving, click Edit Files, then Upload Files. Once the files window opens, choose the folder you want to place files into, or drag and drop files/folders directly.",
        status_start: "Press LAUNCH to start.",
        showFpsWarning: "Show Background FPS Warning",
        showFpsWarningDesc: "Reminds you to disable background FPS limits in software like NVIDIA Control Panel for optimal launcher performance.",
        fpsWarningTitle: "Background FPS Notice",
        fpsWarningText: "To ensure the launcher runs smoothly at full performance, please make sure any FPS-limiting software (such as NVIDIA Control Panel) is not set to cap the frame rate of background applications. Limiting background FPS can cause the launcher to appear sluggish or unresponsive.",
        dontAskAgain: "Don't ask again",
        iUnderstand: "I understand, continue"
    },
    es: {
        home: "Inicio", about: "Acerca de", instances: "Instancias", settings: "Ajustes", launch: "JUGAR", cancel: "Cancelar", selectVer: "Seleccionar versión",
        guest_ready: "¿Listo para jugar, Invitado?", player_ready: "¿Listo para jugar, {name}?",
        lTitle: "Elige una cuenta", lDesc: "Selecciona una cuenta de Microsoft guardada o añade una nueva.",
        msSign: "Añadir cuenta", addAccount: "Añadir cuenta", crSign: "Iniciar No Premium", crTitle: "Usuario No Premium", crDesc: "Introduce tu nombre para jugar sin conexión.",
        manageAccounts: "Administrar Cuentas", manageTitle: "Administrar Cuentas", manageDesc: "Todas las cuentas guardadas aparecen abajo.",
        activeAccount: "Activa", removeAccount: "Eliminar", noAccounts: "Todavía no hay cuentas de Microsoft guardadas.",
        login: "Entrar", back: "Volver", pref: "Preferencias", lSet: "Ajustes del Launcher",
        theme: "Tema", lang: "Idioma", closeOnBoot: "Cerrar launcher al iniciar", simpleMode: "Modo Simple", simpleModeDesc: "Desactiva animaciones y efectos glass para mejor rendimiento.", iSet: "Ajustes de Instancia",
        config: "Configurando:", play: "Tiempo de juego:", ram: "RAM Alocada", ramSub: "Cantidad de memoria para esta versión.",
        adv: "Mostrar Avanzadas ▼", advHide: "Ocultar Avanzadas ▲",
        jvm: "Ajuste JVM", jvmSub: "Lógica de coleta de lixo.", java: "Ruta de Java", javaSub: "Deixe em branco para usar o Java embutido.",
        aboutWhatLean: "¿Qué es Lean Launcher?",
        aboutWhatLeanText: "Lean Launcher es una selección de mods altamente optimizada para Minecraft Java Edition, jugada usando Lean Launcher. Ofrece mejoras esenciales de rendimiento manteniendo la sensación vanilla del juego.",
        aboutWhatOld: "¿Qué es \"Lean Client Old\"?",
        aboutWhatOldText: "Lean Client Old son las primeras versiones de Lean Launcher que hice. Usan mods normales colocados dentro de la instancia. Básicamente son modpacks.",
        aboutUploadTitle: "¿Cómo puedo subir mi propia versión para usarla?",
        aboutUploadText: "Ve a Instâncias y haz clic en + Create new version para crear tu propia versión. Elige un nombre, versión base y tipo de loader, luego guarda. No card da sua versão personalizada, haz clic en Edit Files para abrir o painel editor de arquivos. De lá, use Upload Files para añadir tus mods, configs y recursos na pasta dessa instância. Você também pode abrir arquivos existentes na árvore para editar e salvar diretamente no launcher.",
        status_start: "Presione JUGAR para comenzar.",
        showFpsWarning: "Mostrar aviso de FPS en segundo plano",
        showFpsWarningDesc: "Te recuerda desactivar los límites de FPS en segundo plano en software como NVIDIA Control Panel para un rendimiento óptimo del launcher.",
        fpsWarningTitle: "Aviso de FPS en segundo plano",
        fpsWarningText: "Para que el launcher funcione con fluidez y a pleno rendimiento, asegúrate de que ningún software limitador de FPS (como NVIDIA Control Panel) esté configurado para limitar la tasa de fotogramas de las aplicaciones en segundo plano. Limitar los FPS en segundo plano puede hacer que el launcher se vea lento o no responda.",
        dontAskAgain: "No preguntar de nuevo",
        iUnderstand: "Entiendo, continuar"
    },
    pt: {
        home: "Início", about: "Sobre", instances: "Instâncias", settings: "Config.", launch: "JOGAR", cancel: "Cancelar", selectVer: "Selecionar versão",
        guest_ready: "Pronto para jogar, Visitante?", player_ready: "Pronto para jogar, {name}?",
        lTitle: "Escolha uma conta", lDesc: "Selecione uma conta Microsoft salva ou adicione uma nova.",
        msSign: "Adicionar conta", addAccount: "Adicionar conta", crSign: "Entrar Pirata", crTitle: "Usuário Pirata", crDesc: "Insira seu nome para jogar offline.",
        manageAccounts: "Gerenciar Contas", manageTitle: "Gerenciar Contas", manageDesc: "Todas as contas salvas aparecem abaixo.",
        activeAccount: "Ativa", removeAccount: "Remover", noAccounts: "Ainda não há contas Microsoft salvas.",
        login: "Entrar", back: "Voltar", pref: "Preferências", lSet: "Config. do Launcher",
        theme: "Tema", lang: "Idioma", closeOnBoot: "Fechar launcher ao iniciar", simpleMode: "Modo Simples", simpleModeDesc: "Desativa animações e efeitos glass para melhor desempenho.", iSet: "Config. da Instância",
        config: "Configurando:", play: "Tempo de jogo:", ram: "RAM Alocada", ramSub: "Quantidade de memória para esta versão.",
        adv: "Mostrar Avançadas ▼", advHide: "Ocultar Avançadas ▲",
        jvm: "Ajuste JVM", jvmSub: "Lógica de coleta de lixo.", java: "Caminho do Java", javaSub: "Deixe em branco para usar o Java embutido.",
        aboutWhatLean: "O que é Lean Launcher?",
        aboutWhatLeanText: "Lean Launcher é uma seleção de mods altamente otimizada para Minecraft Java Edition, jogada usando o Lean Launcher. Ele oferece melhorias essenciais de desempenho mantendo a sensação vanilla do jogo.",
        aboutWhatOld: "O que é \"Lean Client Old\"?",
        aboutWhatOldText: "Lean Client Old são as primeiras versões do Lean Launcher que eu fiz. Elas usam mods normais colocados dentro da instância. São basicamente modpacks.",
        aboutUploadTitle: "Como posso enviar minha própria versão para usar?",
        aboutUploadText: "Vá em Instâncias e clique em + Create new version para criar sua própria versão. Escolha um nome, versão base e tipo de loader, depois salve. No card da sua versão personalizada, clique em Edit Files para abrir o painel editor de arquivos. De lá, use Upload Files para adicionar seus mods, configs e recursos na pasta dessa instância. Você também pode abrir arquivos existentes na árvore para editar e salvar diretamente no launcher.",
        status_start: "Pressione JOGAR para começar."
    }
};

function applyTranslations() {
    const lang = globLang.value || 'en';
    const dict = i18n[lang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) el.textContent = dict[key];
    });
    const dName = usernameEl.textContent.trim();
    if (leanDesc) leanDesc.textContent = dName === 'Guest' ? dict.guest_ready : dict.player_ready.replace('{name}', dName);
}

// --- GLOBALS ---
async function loadGlobalSettings() {
    if (!electronAvailable) return;
    const g = await ipcRenderer.invoke('get-global-settings');
    globTheme.value = g.theme || 'light';
    globTheme.dispatchEvent(new Event('change'));
    globLang.value = g.language || 'en';
    globLang.dispatchEvent(new Event('change'));
    if (globCloseOnBoot) globCloseOnBoot.checked = Boolean(g.closeOnBoot);
    if (globSimpleMode) {
        globSimpleMode.checked = Boolean(g.simpleMode);
        if (g.simpleMode) {
            document.documentElement.setAttribute('data-simple', 'true');
            stopBubbles();
            stopRain();
        } else {
            document.documentElement.removeAttribute('data-simple');
        }
    }
    if (globShowFpsWarning) {
        globShowFpsWarning.checked = g.showFpsWarning !== false;
    }
    if (globAnimation) {
        globAnimation.value = g.animation || 'bubbles';
        applyAnimation(globAnimation.value);
    }
    document.documentElement.setAttribute('data-theme', globTheme.value);
    applyTranslations();
}

function saveGlobalSettings() {
    if (!electronAvailable) return;
    const g = {
        theme: globTheme.value,
        language: globLang.value,
        closeOnBoot: Boolean(globCloseOnBoot?.checked),
        simpleMode: Boolean(globSimpleMode?.checked),
        showFpsWarning: Boolean(globShowFpsWarning?.checked),
        animation: globAnimation ? globAnimation.value : 'bubbles'
    };
    document.documentElement.setAttribute('data-theme', g.theme);
    if (g.simpleMode) {
        document.documentElement.setAttribute('data-simple', 'true');
        stopBubbles();
        stopRain();
    } else {
        document.documentElement.removeAttribute('data-simple');
        applyAnimation(g.animation || 'bubbles');
    }
    applyTranslations();
    ipcRenderer.invoke('save-global-settings', g).catch(err => {
        console.error('[Settings] Failed to save global settings:', err);
    });
}

function formatCrashReport(report) {
    if (!report || typeof report !== 'object') return 'No details were provided.';

    const sections = [];
    const when = report.timestamp ? new Date(report.timestamp).toLocaleString() : 'Unknown time';

    // ---- Summary ----
    sections.push('═══════════════════════════════════');
    sections.push('  CRASH SUMMARY');
    sections.push('═══════════════════════════════════');
    sections.push(`  Time     : ${when}`);
    if (report.version) sections.push(`  Version  : ${report.version}`);
    if (report.profile) sections.push(`  Profile  : ${report.profile}`);
    if (typeof report.code === 'number' || report.signal) {
        sections.push(`  Exit     : code=${report.code ?? '?'}  signal=${report.signal || 'none'}`);
    }
    if (report.message) sections.push(`  Note     : ${report.message}`);

    // ---- Configuration ----
    const hasConfig = report.allocatedRamMb || report.jvmPreset || report.customType || report.javaVersionLogLine;
    if (hasConfig) {
        sections.push('');
        sections.push('── Configuration ──');
        if (report.allocatedRamMb) sections.push(`  RAM       : ${report.allocatedRamMb} MB`);
        if (report.jvmPreset) sections.push(`  JVM Preset: ${report.jvmPreset}`);
        if (report.jvmArgs) sections.push(`  JVM Args  : ${Array.isArray(report.jvmArgs) ? report.jvmArgs.join(' ') : report.jvmArgs}`);
        if (report.javaPath) sections.push(`  Java Path : ${report.javaPath}`);
        if (report.javaVersionLogLine) sections.push(`  Java Info : ${report.javaVersionLogLine}`);
        if (report.systemMemoryLogLine) sections.push(`  Sys Mem   : ${report.systemMemoryLogLine}`);
    }

    // ---- Likely cause ----
    if (report.errorClass || report.errorSummary) {
        sections.push('');
        sections.push('── Likely Error ──');
        if (report.errorClass) sections.push(`  Class    : ${report.errorClass}`);
        if (report.errorSummary) sections.push(`  Message  : ${report.errorSummary}`);
    }

    // ---- Crash file path ----
    if (report.crashReportFile) sections.push(`\n  Crash file: ${report.crashReportFile}`);

    // ---- Suggestions ----
    const suggestions = [];
    if (report.errorClass) {
        if (/OutOfMemoryError|Java heap space/i.test(report.errorClass) || /Memory/i.test(report.errorSummary || '')) {
            suggestions.push('• Increase allocated RAM in Instance Settings (try 4096 MB or higher).');
            suggestions.push('• If using custom JVM args, make sure -Xmx matches your desired limit.');
        }
        if (/ClassNotFound|NoClassDefFound/i.test(report.errorClass)) {
            suggestions.push('• A required mod or library is missing. Try switching profiles or reinstalling the version.');
        }
        if (/UnsatisfiedLinkError|Native/i.test(report.errorClass)) {
            suggestions.push('• A native library failed to load. Check that your graphics drivers are up to date.');
        }
        if (/InvocationTargetException/i.test(report.errorClass)) {
            suggestions.push('• A mod or loader failed to initialize. Check the crash report file for the root cause.');
        }
    }
    if (report.code === 1 || report.signal) {
        suggestions.push('• The process was terminated unexpectedly. Check for antivirus interference or low system resources.');
        if (report.signal === 'SIGKILL') suggestions.push('• SIGKILL often means an out-of-memory killer or forced termination.');
    }
    if (!suggestions.length) {
        suggestions.push('• Check the crash report file below for specific mod or game errors.');
        suggestions.push('• Try launching with a different mod profile or clearing the instance mods folder.');
    }
    sections.push('');
    sections.push('── Suggestions ──');
    sections.push(suggestions.join('\n'));

    // ---- Crash report tail ----
    if (report.crashReportPreview) {
        sections.push('');
        sections.push('───────────────────────────────────');
        sections.push('  CRASH REPORT (last 120 lines)');
        sections.push('───────────────────────────────────');
        sections.push(report.crashReportPreview);
    }

    // ---- latest.log tail ----
    if (report.latestLogTail) {
        sections.push('');
        sections.push('───────────────────────────────────');
        sections.push('  LATEST.LOG (last 120 lines)');
        sections.push('───────────────────────────────────');
        sections.push(report.latestLogTail);
    }

    return sections.join('\n');
}

function hideCrashReportModal() {
    if (!crashReportModal) return;
    crashReportModal.classList.remove('visible');
    setTimeout(() => crashReportModal.classList.add('hidden'), 260);
}

function showCrashReportModal(report) {
    if (!crashReportModal) return;
    if (crashReportTitle) crashReportTitle.textContent = 'Minecraft Crash Report';
    if (crashReportMessage) crashReportMessage.textContent = report?.message || 'The game exited unexpectedly.';
    if (crashReportDetails) crashReportDetails.value = formatCrashReport(report);
    crashReportModal.classList.remove('hidden');
    requestAnimationFrame(() => crashReportModal.classList.add('visible'));
}

// --- INSTANCES ---
function formatPlaytime(ms) {
    if (!ms) return "0h 0m";
    const totalMins = Math.floor(ms / 60000);
    return `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`;
}

function formatProfileName(profile) {
    if (!profile) return 'Full';
    return profile.charAt(0).toUpperCase() + profile.slice(1);
}

function sortProfiles(profiles) {
    const unique = [...new Set((profiles || []).filter(Boolean))];
    return unique.sort((a, b) => {
        const ai = PROFILE_ORDER.indexOf(a);
        const bi = PROFILE_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
    });
}

function updateRamRemainingDisplay() {
    if (!ramRemainingText) return;
    if (!Number.isFinite(totalSystemRamMb) || totalSystemRamMb <= 0) {
        ramRemainingText.textContent = 'RAM left on computer: --';
        return;
    }

    const selectedGb = normalizeRamGb(setRam?.value || 4);
    const selectedMb = gbToMb(selectedGb);
    const remainingMb = Math.max(0, totalSystemRamMb - selectedMb);
    const remainingGb = remainingMb / 1024;
    const totalGb = totalSystemRamMb / 1024;
    ramRemainingText.textContent = `RAM left on computer: ${formatRamGb(Number(remainingGb.toFixed(1)))} GB (${formatRamGb(Number(totalGb.toFixed(1)))} GB total)`;
}

function positionNavIndicator(activeBtn, immediate = false) {
    if (!navLinks || !navIndicator || !activeBtn) return;
    const btnRect = activeBtn.getBoundingClientRect();
    const parentRect = navLinks.getBoundingClientRect();
    if (immediate) {
        navIndicator.style.transition = 'none';
    }
    navIndicator.style.left = `${btnRect.left - parentRect.left}px`;
    navIndicator.style.width = `${btnRect.width}px`;
    navIndicator.style.opacity = '1';
    if (immediate) {
        requestAnimationFrame(() => {
            navIndicator.style.transition = '';
        });
    }
}

async function renderLaunchProfileSelector(version, settingsOverride = null) {
    if (!launchProfileSelect || !launchProfileContainer || !electronAvailable) return;

    const s = settingsOverride || await ipcRenderer.invoke('get-settings', version);
    const availableProfiles = sortProfiles(Array.isArray(s?.availableProfiles) && s.availableProfiles.length ? s.availableProfiles : ['full']);
    const activeProfile = availableProfiles.includes(s?.activeProfile) ? s.activeProfile : availableProfiles[0];

    launchProfileSelect.innerHTML = '';
    availableProfiles.forEach((profile) => {
        const option = document.createElement('option');
        option.value = profile;
        option.textContent = `${formatProfileName(profile)} Profile`;
        launchProfileSelect.appendChild(option);
    });

    launchProfileSelect.value = activeProfile;
    launchProfileContainer.classList.toggle('visible', availableProfiles.length > 1);
}

async function renderOfficialLeanProfileActions() {
    if (!electronAvailable) return;

    const actionGroups = Array.from(document.querySelectorAll('.lean-version-actions[data-lean-actions-version]'));
    for (const group of actionGroups) {
        const version = group.dataset.leanActionsVersion;
        if (!version) continue;

        const settings = await ipcRenderer.invoke('get-settings', version);
        const availableProfiles = sortProfiles(Array.isArray(settings?.availableProfiles) && settings.availableProfiles.length ? settings.availableProfiles : ['full']);
        const activeProfile = availableProfiles.includes(settings?.activeProfile) ? settings.activeProfile : availableProfiles[0];

        group.innerHTML = '';
        availableProfiles.forEach((profile) => {
            const button = document.createElement('button');
            button.className = 'custom-version-action-btn lean-version-profile-btn';
            button.type = 'button';
            button.textContent = `Select ${formatProfileName(profile)} Profile`;
            button.dataset.version = version;
            button.dataset.profile = profile;
            if (profile === activeProfile) button.classList.add('active');
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                const selectedVersion = button.dataset.version;
                const selectedProfile = button.dataset.profile;
                const existing = await ipcRenderer.invoke('get-settings', selectedVersion);
                await ipcRenderer.invoke('save-settings', {
                    version: selectedVersion,
                    settings: {
                        ...existing,
                        activeProfile: selectedProfile
                    }
                });

                if (versionSelect) {
                    versionSelect.value = selectedVersion;
                    versionSelect.dispatchEvent(new Event('change'));
                }

                if (launchProfileSelect) launchProfileSelect.value = selectedProfile;
                btnHome?.click();
            });
            group.appendChild(button);
        });

        const slotMap = {
            1: ['lean-action-single'],
            2: ['lean-action-top', 'lean-action-bottom'],
            3: ['lean-action-top', 'lean-action-bottom-left', 'lean-action-bottom-right']
        };
        const slots = slotMap[availableProfiles.length] || slotMap[3];
        Array.from(group.children).forEach((button, index) => {
            button.classList.remove('lean-action-single', 'lean-action-top', 'lean-action-bottom', 'lean-action-bottom-left', 'lean-action-bottom-right');
            button.classList.add(slots[index] || slots[slots.length - 1]);
        });
    }
}

async function loadInstanceSettings() {
    if (!electronAvailable) return;
    const version = setInstanceSelect.value;
    const s = await ipcRenderer.invoke('get-settings', version);
    const allSettings = await ipcRenderer.invoke('get-all-settings');
    const totalPlaytimeMs = Object.entries(allSettings || {}).reduce((sum, [key, value]) => {
        if (key === '_global' || !value || typeof value !== 'object') return sum;
        const playtime = Number(value.playtime) || 0;
        return sum + playtime;
    }, 0);
    const ramMb = normalizeRamMb(s.ram || "4096");
    const ramGb = normalizeRamGb(mbToGb(ramMb));
    if (setRam) setRam.value = formatRamGb(ramGb);
    if (setRamSlider) setRamSlider.value = String(clampRamForSlider(ramGb));
    setPreset.value = s.preset || "default";
    setJvm.value = Array.isArray(s.jvmArgs) ? s.jvmArgs.join(' ') : (s.jvmArgs || '');
    setJavaPath.value = s.javaPath || "";
    playtimeText.textContent = formatPlaytime(s.playtime);
    if (playtimeTotalText) playtimeTotalText.textContent = formatPlaytime(totalPlaytimeMs);
    customArgsContainer.style.display = setPreset.value === 'custom' ? 'flex' : 'none';
    updateRamRemainingDisplay();
    await renderLaunchProfileSelector(version, s);
}

async function saveInstanceSettings() {
    if (!electronAvailable) return;
    const version = setInstanceSelect.value;
    const existing = await ipcRenderer.invoke('get-settings', version);
    const s = {
        ...existing,
        ram: String(normalizeRamMb(gbToMb(normalizeRamGb(setRam?.value || setRamSlider?.value || "4")))),
        preset: setPreset.value,
        jvmArgs: (setJvm.value || '').trim().split(/\s+/).filter(Boolean),
        javaPath: setJavaPath.value,
        playtime: existing?.playtime || 0
    };
    ipcRenderer.invoke('save-settings', { version, settings: s });
}

const debouncedSaveInstanceSettings = debounce(saveInstanceSettings, 300);

// --- CORE UI ---
function setSignedInState(allowed) {
    isSignedIn = allowed;
    launchGroup?.classList.toggle('disabled', !allowed);
}

function updateProfileDisplay(name, minecraftId) {
    const dName = name?.trim() || (minecraftId ? 'Player' : 'Guest');
    usernameEl.textContent = dName;
    if (playerHead) {
        if (minecraftId && minecraftId !== "00000000000000000000000000000000") playerHead.src = `https://mc-heads.net/avatar/${minecraftId}/100`;
        else if (dName === 'Guest') playerHead.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' rx='20' fill='%23e8e8e8'/%3E%3Ctext x='50' y='60' font-family='Inter, sans-serif' font-size='52' fill='%23333' text-anchor='middle'%3E?%3C/text%3E%3C/svg%3E";
        else playerHead.src = `https://mc-heads.net/avatar/${dName}/100`;
    }
    applyTranslations();
    setSignedInState(dName !== 'Guest');
}

function getDefaultGuestAvatar() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' rx='20' fill='%23e8e8e8'/%3E%3Ctext x='50' y='60' font-family='Inter, sans-serif' font-size='52' fill='%23333' text-anchor='middle'%3E?%3C/text%3E%3C/svg%3E";
}

function syncActiveAccountDisplay(state, fallbackName = 'Guest', fallbackMinecraftId = null) {
    const activeAccount = state?.accounts?.find((account) => account.id === state?.activeAccountId) || null;
    if (activeAccount) {
        updateProfileDisplay(activeAccount.accountName, activeAccount.minecraftId);
        return activeAccount;
    }

    if (fallbackName) updateProfileDisplay(fallbackName, fallbackMinecraftId);
    return null;
}

function animateAccountRemoval(accountCard, onDone) {
    if (!accountCard) {
        onDone();
        return;
    }

    accountCard.style.maxHeight = `${accountCard.scrollHeight}px`;
    requestAnimationFrame(() => accountCard.classList.add('removing'));
    setTimeout(onDone, ACCOUNT_REMOVE_ANIM_MS);
}

function animateAccountPromote(accountId, onDone) {
    if (!loginAccountsList || !accountId) {
        onDone();
        return;
    }

    const accountCard = loginAccountsList.querySelector(`.auth-account-card[data-account-id="${accountId}"]`);
    if (!accountCard || loginAccountsList.firstElementChild === accountCard) {
        onDone();
        return;
    }

    const fromRect = accountCard.getBoundingClientRect();
    accountCard.classList.add('promoting', 'promote-behind');
    loginAccountsList.insertBefore(accountCard, loginAccountsList.firstElementChild);

    const toRect = accountCard.getBoundingClientRect();
    const deltaY = fromRect.top - toRect.top;

    accountCard.style.transition = 'none';
    accountCard.style.transform = `translateY(${deltaY}px) scale(0.96)`;
    void accountCard.offsetHeight;

    requestAnimationFrame(() => {
        accountCard.style.transition = `transform ${ACCOUNT_PROMOTE_MOVE_MS}ms cubic-bezier(0.2, 0.7, 0.2, 1), opacity 110ms ease`;
        accountCard.style.transform = 'translateY(0) scale(0.96)';
    });

    setTimeout(() => {
        accountCard.classList.remove('promote-behind');
        accountCard.classList.add('promote-front');
        accountCard.style.transition = `transform ${ACCOUNT_PROMOTE_FRONT_MS}ms ease`;
        accountCard.style.transform = 'translateY(0) scale(1)';
    }, ACCOUNT_PROMOTE_MOVE_MS - 10);

    setTimeout(() => {
        accountCard.classList.remove('promoting', 'promote-front');
        accountCard.style.transition = '';
        accountCard.style.transform = '';
        onDone();
    }, ACCOUNT_PROMOTE_MOVE_MS + ACCOUNT_PROMOTE_FRONT_MS + 20);
}

function applyImmediateActivePill(accountCard, dict) {
    if (!loginAccountsList || !accountCard) return;

    loginAccountsList.querySelectorAll('.auth-account-card').forEach((card) => {
        card.classList.remove('active');
        const badge = card.querySelector('.auth-account-badge');
        if (badge) badge.remove();
    });

    accountCard.classList.add('active');
    const nameRow = accountCard.querySelector('.auth-account-name-row');
    if (!nameRow || nameRow.querySelector('.auth-account-badge')) return;

    const badge = document.createElement('span');
    badge.className = 'auth-account-badge';
    badge.textContent = dict.activeAccount;
    nameRow.appendChild(badge);
}

function renderAuthAccounts(authState) {
    if (!loginAccountsList) return;

    const accounts = Array.isArray(authState?.accounts) ? [...authState.accounts] : [];
    const activeAccountId = authState?.activeAccountId || null;
    const dict = i18n[globLang.value || 'en'] || i18n.en;
    loginAccountsList.innerHTML = '';

    if (!accounts.length) {
        if (loginAccountsEmpty) loginAccountsEmpty.hidden = false;
        return;
    }

    if (loginAccountsEmpty) loginAccountsEmpty.hidden = true;

    const sortedAccounts = [...accounts].sort((left, right) => {
        if (left.id === activeAccountId && right.id !== activeAccountId) return -1;
        if (right.id === activeAccountId && left.id !== activeAccountId) return 1;
        return 0;
    });

    for (const account of sortedAccounts) {
        const accountCard = document.createElement('div');
        accountCard.className = `auth-account-card${account.id === activeAccountId ? ' active' : ''}`;
        accountCard.dataset.accountId = account.id;
        accountCard.tabIndex = 0;
        accountCard.setAttribute('role', 'button');

        const avatar = account.minecraftId && account.minecraftId !== '00000000000000000000000000000000'
            ? `https://mc-heads.net/avatar/${account.minecraftId}/100`
            : getDefaultGuestAvatar();

        accountCard.innerHTML = `
            <img class="auth-account-avatar" src="${avatar}" alt="${account.accountName}">
            <div class="auth-account-meta">
                <div class="auth-account-name-row">
                    <span class="auth-account-name"></span>
                    ${account.id === activeAccountId ? `<span class="auth-account-badge">${dict.activeAccount}</span>` : ''}
                </div>
                <span class="auth-account-subtitle"></span>
            </div>
        `;

        accountCard.querySelector('.auth-account-name').textContent = account.accountName || 'Player';
        accountCard.querySelector('.auth-account-subtitle').textContent = account.type === 'offline' ? 'Offline' : account.minecraftId || account.userId || '';

        accountCard.addEventListener('click', async () => {
            applyImmediateActivePill(accountCard, dict);
            if (!electronAvailable) return;
            const result = await ipcRenderer.invoke('activate-auth-account', account.id);
            if (!result?.success) return;
            animateAccountPromote(account.id, () => {
                authAccountsState = result.result || authAccountsState;
                renderAuthAccounts(authAccountsState);
                syncActiveAccountDisplay(authAccountsState);
            });
        });

        accountCard.addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            applyImmediateActivePill(accountCard, dict);
            if (!electronAvailable) return;
            const result = await ipcRenderer.invoke('activate-auth-account', account.id);
            if (!result?.success) return;
            animateAccountPromote(account.id, () => {
                authAccountsState = result.result || authAccountsState;
                renderAuthAccounts(authAccountsState);
                syncActiveAccountDisplay(authAccountsState);
            });
        });

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'auth-account-remove-btn';
        removeButton.textContent = '×';
        removeButton.title = dict.removeAccount;
        removeButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!electronAvailable) return;
            animateAccountRemoval(accountCard, async () => {
                const result = await ipcRenderer.invoke('remove-auth-account', account.id);
                if (!result?.success) {
                    renderAuthAccounts(authAccountsState);
                    return;
                }
                authAccountsState = result.result || authAccountsState;
                renderAuthAccounts(authAccountsState);
                const activeAccount = syncActiveAccountDisplay(authAccountsState);
                if (!activeAccount) updateProfileDisplay('Guest');
            });
        });

        accountCard.appendChild(removeButton);
        loginAccountsList.appendChild(accountCard);
    }
}

async function refreshAuthAccounts() {
    if (!electronAvailable || !ipcRenderer) {
        authAccountsState = { activeAccountId: null, accounts: [] };
        renderAuthAccounts(authAccountsState);
        return authAccountsState;
    }

    const state = await ipcRenderer.invoke('get-auth-accounts');
    authAccountsState = state?.accounts ? state : { activeAccountId: null, accounts: [] };
    renderAuthAccounts(authAccountsState);
    return authAccountsState;
}

function showLoginModal(show) {
    if (show) {
        // Close other popups that stack above login
        if (screenshotsModal?.classList.contains('visible')) closeScreenshotManager();
        if (fpsWarningModal?.classList.contains('visible')) hideModalGeneric(fpsWarningModal, 350);
        if (loginHideTimer) {
            clearTimeout(loginHideTimer);
            loginHideTimer = null;
        }
        loginModal.classList.remove('hidden');
        requestAnimationFrame(() => loginModal.classList.add('visible'));

        // Only show the main login card by default.
        mainView.classList.add('active-view');
        mainView.classList.remove('fade-left', 'fade-right');
        manageView.classList.remove('active-view', 'fade-left', 'fade-right');
        manageView.classList.add('fade-right');
        crackedView.classList.remove('active-view', 'fade-left', 'fade-right');
        crackedView.classList.add('fade-right');
        crackedInput.value = "";
        void refreshAuthAccounts();
    } else {
        loginModal.classList.remove('visible');
        loginHideTimer = setTimeout(() => {
            loginModal.classList.add('hidden');
            loginHideTimer = null;
        }, 260);

        // Hide both cards
        mainView.classList.remove('active-view', 'fade-left', 'fade-right');
        manageView.classList.remove('active-view', 'fade-left', 'fade-right');
        crackedView.classList.remove('active-view', 'fade-left', 'fade-right');
    }
}

function setStatus(message, progress = 0) {
    if (statusText) statusText.textContent = message;
    if (statusProgress) statusProgress.style.width = `${progress}%`;
}

// --- Changelog / What's New ---
const CHANGELOG_FALLBACK = [
  {
    version: '1.0.0',
    date: 'May 31, 2026',
    title: 'This is the first release of Lean Launcher.',
    description: '',
    features: [
      {
        title: 'Lean Launcher Features',
        items: [
          'Custom version creation and editing',
          'Per-instance settings with RAM and JVM controls',
          'Instance file manager with upload and drag/drop support',
          'Theme system, language selection, and profile selection'
        ]
      },
      {
        title: 'Client Features',
        items: [
          'Performance-focused client experience',
          'Lean Client Old version support',
          'Multiple version targets and profile options',
          'Ready for lightweight and customizable setups'
        ]
      }
    ]
  }
];

const MAX_VISIBLE_BARS = 3;

function buildFullEntry(entry) {
  const featuresHtml = entry.features && entry.features.length
    ? `<div class="feature-columns">${entry.features.map(f =>
      `<div class="feature-column">
        <h4>${f.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h4>
        <ul>${f.items.map(item => `<li>${item.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`).join('')}</ul>
      </div>`
    ).join('')}</div>`
    : '';

  const safeTitle = entry.title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const safeDate = entry.date.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const safeDesc = entry.description ? `<p>${entry.description.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : '';

  return `
    <h3>What's New?</h3>
    <p class="whats-new-meta">Announcement Date: ${safeDate}</p>
    <p>${safeTitle}</p>
    ${safeDesc}
    ${featuresHtml}
  `;
}

async function renderChangelog() {
  const container = document.getElementById('whats-new-container');
  if (!container) return;

  let entries = CHANGELOG_FALLBACK;

  // Try loading from IPC (Electron) or fetch (browser fallback)
  if (electronAvailable && ipcRenderer) {
    try {
      const result = await ipcRenderer.invoke('read-changelog');
      if (result && Array.isArray(result) && result.length) entries = result;
    } catch (e) { console.warn('IPC changelog load failed, using fallback:', e); }
  } else {
    try {
      const resp = await fetch('changelog.json');
      if (resp.ok) {
        const json = await resp.json();
        if (Array.isArray(json) && json.length) entries = json;
      }
    } catch (e) { console.warn('Fetch changelog load failed, using fallback:', e); }
  }

  // Sort newest first
  entries = entries.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!entries.length) return;

  container.innerHTML = '';

  // --- Latest entry (full detail) ---
  const latest = entries[0];
  const latestEl = document.createElement('div');
  latestEl.className = 'changelog-latest';
  latestEl.innerHTML = buildFullEntry(latest);
  container.appendChild(latestEl);

  // --- Previous entries as collapsible bars ---
  const previous = entries.slice(1);
  if (!previous.length) return;

  // Divider between latest and history
  const divider = document.createElement('hr');
  divider.className = 'changelog-divider';
  container.appendChild(divider);

  let visibleCount = 0;

  previous.forEach((entry) => {
    const isHidden = visibleCount >= MAX_VISIBLE_BARS;
    const wrapper = document.createElement('div');
    wrapper.className = 'changelog-bar-wrapper';
    if (isHidden) wrapper.classList.add('changelog-hidden');

    const bar = document.createElement('div');
    bar.className = 'changelog-bar';
    bar.innerHTML = `
      <span class="bar-version">v${entry.version.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>
      <span class="bar-date">${entry.date.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>
      <span class="bar-title">${entry.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>
      <span class="bar-arrow">▾</span>
    `;

    const detail = document.createElement('div');
    detail.className = 'changelog-bar-detail';
    detail.innerHTML = buildFullEntry(entry);

    bar.addEventListener('click', () => {
      const isOpen = bar.classList.contains('open');
      if (isOpen) {
        bar.classList.remove('open');
        detail.style.maxHeight = '0';
        detail.style.opacity = '0';
        detail.style.marginTop = '0';
        detail.style.borderColor = 'transparent';
        detail.style.padding = '0 16px';
      } else {
        bar.classList.add('open');
        detail.style.maxHeight = detail.scrollHeight + 'px';
        detail.style.opacity = '1';
        detail.style.marginTop = '8px';
        detail.style.borderColor = '';
        detail.style.padding = '14px 16px';
      }
    });

    wrapper.appendChild(bar);
    wrapper.appendChild(detail);
    container.appendChild(wrapper);

    if (!isHidden) visibleCount++;
  });

  // --- Show More / Show Less button ---
  if (previous.length > MAX_VISIBLE_BARS) {
    const showMoreBtn = document.createElement('button');
    showMoreBtn.className = 'changelog-show-more';
    showMoreBtn.textContent = `Show More (${previous.length - MAX_VISIBLE_BARS} more)`;
    showMoreBtn.addEventListener('click', () => {
      const hidden = container.querySelectorAll('.changelog-hidden');
      const isShowing = showMoreBtn.dataset.expanded === 'true';
      if (isShowing) {
        hidden.forEach(w => w.classList.add('changelog-hidden'));
        showMoreBtn.textContent = `Show More (${previous.length - MAX_VISIBLE_BARS} more)`;
        showMoreBtn.dataset.expanded = 'false';
      } else {
        hidden.forEach(w => w.classList.remove('changelog-hidden'));
        showMoreBtn.textContent = 'Show Less';
        showMoreBtn.dataset.expanded = 'true';
      }
    });
    container.appendChild(showMoreBtn);
  }
}

function initAboutAccordion() {
    const items = document.querySelectorAll('.qa-item');
    items.forEach((item) => {
        const toggle = item.querySelector('.qa-toggle');
        const answer = item.querySelector('.qa-answer');
        if (!toggle || !answer) return;

        toggle.addEventListener('click', () => {
            const opening = !item.classList.contains('open');
            if (opening) {
                item.classList.add('open');
                answer.style.maxHeight = `${answer.scrollHeight}px`;
                toggle.setAttribute('aria-expanded', 'true');
            } else {
                answer.style.maxHeight = `${answer.scrollHeight}px`;
                requestAnimationFrame(() => {
                    answer.style.maxHeight = '0px';
                });
                item.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
            }
        });
    });
}

if (electronAvailable && ipcRenderer) {
    ipcRenderer.on('auth-device-code', (event, codeInfo) => {
        const url = codeInfo.verification_uri || 'https://microsoft.com/link';
        alert('To sign in:\n\n1. Go to ' + url + '\n2. Enter this code: ' + codeInfo.user_code + '\n\nWaiting for you to complete sign-in...');
    });

    ipcRenderer.on('launch-update', (event, data) => {
        setStatus(data.msg, data.prog);
        if (data.msg === 'Launch complete!' || data.prog >= 100) {
            statusText.textContent = 'Launch completed!';
            setTimeout(() => {
                if (statusBar) statusBar.classList.remove('visible');
            }, 1000);
        }
    });

    ipcRenderer.on('launch-crash-report', (event, report) => {
        setStatus(report?.message || 'Minecraft crashed.', 0);
        showCrashReportModal(report || {});
    });
}

async function initUI() {
    updateProfileDisplay('Guest');
    setSignedInState(false);
    initAboutAccordion();
    renderChangelog();

    const leanVersions = ['1.21.11', '1.21.7', '1.21.4', '1.20', '1.19.4'];
    const topViewByButton = new Map([[btnHome, homeView], [btnSettings, settingsView], [btnInstances, instancesView], [btnAbout, aboutView]]);

    try {
        const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const data = await res.json();
        const baseSelect = document.getElementById('new-version-base');
        if (baseSelect) {
            baseSelect.innerHTML = '';
            data.versions.filter(v => v.type === 'release').forEach(v => {
                const isLean = leanVersions.includes(v.id);

                if (isLean) {
                    const leanOpt = document.createElement('option');
                    leanOpt.value = `lean:${v.id}`;
                    leanOpt.textContent = `${v.id} Lean Client Old`;
                    leanOpt.dataset.lean = 'true';
                    leanOpt.dataset.baseVersion = v.id;
                    leanOpt.style.color = 'var(--accent)';
                    leanOpt.style.fontWeight = 'bold';
                    baseSelect.appendChild(leanOpt);
                }

                const normalOpt = document.createElement('option');
                normalOpt.value = v.id;
                normalOpt.textContent = v.id;
                normalOpt.dataset.lean = 'false';
                normalOpt.dataset.baseVersion = v.id;
                normalOpt.style.color = 'var(--text)';
                normalOpt.style.fontWeight = 'normal';
                baseSelect.appendChild(normalOpt);
            });

            const selectedBase = baseSelect.options[baseSelect.selectedIndex];
            const isSelectedLean = selectedBase?.dataset.lean === 'true';
            baseSelect.style.color = isSelectedLean ? 'var(--accent)' : 'var(--text)';
            baseSelect.style.fontWeight = isSelectedLean ? 'bold' : 'normal';
            baseSelect.addEventListener('change', () => {
                const selected = baseSelect.options[baseSelect.selectedIndex];
                const isLean = selected?.dataset.lean === 'true';
                baseSelect.style.color = isLean ? 'var(--accent)' : 'var(--text)';
                baseSelect.style.fontWeight = isLean ? 'bold' : 'normal';
            });
        }
    } catch(e) { console.error('Failed to load mojang versions', e); }
    
    document.getElementById('minimize-btn')?.addEventListener('click', () => ipcRenderer?.invoke('window-minimize'));
    document.getElementById('maximize-btn')?.addEventListener('click', () => ipcRenderer?.invoke('window-maximize-toggle'));
    document.getElementById('close-btn')?.addEventListener('click', () => ipcRenderer?.invoke('window-close'));

    await loadGlobalSettings();
    if (electronAvailable) {
        const session = await ipcRenderer.invoke('check-session');
        if (session?.success) {
            authAccountsState = {
                activeAccountId: session.result.activeAccountId || session.result.accountId || null,
                accounts: session.result.accounts || []
            };
            updateProfileDisplay(session.result.name, session.result.minecraftId);
        } else {
            authAccountsState = { activeAccountId: null, accounts: [] };
            updateProfileDisplay('Guest');
        }
        renderAuthAccounts(authAccountsState);
        const memoryInfo = await ipcRenderer.invoke('get-system-memory');
    globSimpleMode?.addEventListener('change', saveGlobalSettings);
        totalSystemRamMb = Number(memoryInfo?.totalMb) || null;
    }
    await loadInstanceSettings();
    await renderOfficialLeanProfileActions();

    globTheme.addEventListener('change', saveGlobalSettings);
    globLang.addEventListener('change', saveGlobalSettings);
    globCloseOnBoot?.addEventListener('change', saveGlobalSettings);
    globShowFpsWarning?.addEventListener('change', saveGlobalSettings);
    globAnimation?.addEventListener('change', () => { saveGlobalSettings(); applyAnimation(globAnimation.value); });
    
    setInstanceSelect.addEventListener('change', loadInstanceSettings);
    setInstanceSelect.addEventListener('change', loadInstanceSettings);
    versionSelect?.addEventListener('change', (e) => { setInstanceSelect.value = e.target.value; loadInstanceSettings(); });
    launchProfileSelect?.addEventListener('change', async () => {
        if (!electronAvailable || !versionSelect) return;
        const version = versionSelect.value;
        const existing = await ipcRenderer.invoke('get-settings', version);
        await ipcRenderer.invoke('save-settings', {
            version,
            settings: {
                ...existing,
                activeProfile: launchProfileSelect.value
            }
        });
        await renderOfficialLeanProfileActions();
    });
    setRamSlider?.addEventListener('input', () => {
        const sliderGb = applySoftRamSnap(normalizeRamGb(setRamSlider.value));
        setRamSlider.value = String(sliderGb);
        if (setRam) setRam.value = formatRamGb(sliderGb);
        updateRamRemainingDisplay();
        debouncedSaveInstanceSettings();
    });
    setRam?.addEventListener('input', () => {
        const ramGb = normalizeRamGb(setRam.value);
        if (setRamSlider) setRamSlider.value = String(applySoftRamSnap(ramGb));
        updateRamRemainingDisplay();
    });
    setRam?.addEventListener('change', () => {
        const ramGb = normalizeRamGb(setRam.value);
        setRam.value = formatRamGb(ramGb);
        if (setRamSlider) setRamSlider.value = String(applySoftRamSnap(ramGb));
        updateRamRemainingDisplay();
        debouncedSaveInstanceSettings();
    });
    setPreset.addEventListener('change', (e) => { customArgsContainer.style.display = e.target.value === 'custom' ? 'flex' : 'none'; debouncedSaveInstanceSettings(); });
    setJvm.addEventListener('input', debouncedSaveInstanceSettings);
    setJavaPath.addEventListener('input', debouncedSaveInstanceSettings);

    toggleAdvancedBtn.addEventListener('click', () => {
        const isOpen = advancedPanel.classList.toggle('open');
        toggleAdvancedBtn.textContent = isOpen ? i18n[globLang.value].advHide : i18n[globLang.value].adv;
    });

    function updateDropdownColors() {
        [versionSelect, setInstanceSelect, screenshotsVersionSelect].forEach(sel => {
            if(!sel) return;
            
            Array.from(sel.options).forEach(opt => {
                const isLean = leanVersions.includes(opt.value);
                const isCustom = opt.dataset.custom === 'true';
                const customAccent = opt.dataset.accent;

                if (isLean) opt.textContent = `${opt.value} Lean Client Old`;

                if (isLean) {
                    opt.style.color = 'var(--accent)';
                    opt.style.fontWeight = 'bold';
                } else if (isCustom && customAccent) {
                    opt.style.color = customAccent;
                    opt.style.fontWeight = '700';
                } else {
                    opt.style.color = 'var(--text)';
                    opt.style.fontWeight = 'normal';
                }
            });
            
            const selectedOpt = sel.options[sel.selectedIndex];
            const isLeanSelected = selectedOpt && leanVersions.includes(selectedOpt.value);
            const isCustomSelected = selectedOpt?.dataset.custom === 'true';
            const selectedCustomAccent = selectedOpt?.dataset.accent;

            if (isLeanSelected) {
                sel.style.color = 'var(--accent)';
                sel.style.fontWeight = 'bold';
            } else if (isCustomSelected && selectedCustomAccent) {
                sel.style.color = selectedCustomAccent;
                sel.style.fontWeight = '700';
            } else {
                sel.style.color = 'var(--text)';
                sel.style.fontWeight = 'normal';
            }
        });
    }

    [versionSelect, setInstanceSelect, screenshotsVersionSelect].forEach(sel => {
        if(sel) {
            sel.addEventListener('change', updateDropdownColors);
        }
    });
    updateDropdownColors();

    const pageOrder = new Map([
        [homeView, 0],
        [settingsView, 1],
        [instancesView, 2],
        [aboutView, 3],
        [createVersionView, 4]
    ]);
    const topNavButtons = [btnHome, btnSettings, btnInstances, btnAbout];
    let currentPage = document.querySelector('.page-view.active-page') || homeView;
    positionNavIndicator(document.querySelector('.nav-btn.active'), true);
    window.addEventListener('resize', () => {
        positionNavIndicator(document.querySelector('.nav-btn.active'));
    });

    function getTransitionDirection(fromView, toView) {
        const fromIdx = pageOrder.get(fromView) ?? 0;
        const toIdx = pageOrder.get(toView) ?? 0;
        return toIdx > fromIdx ? 'rtl' : 'ltr';
    }

    function getVersionSelects() {
        return [versionSelect, setInstanceSelect, screenshotsVersionSelect].filter(Boolean);
    }

    function getCreateFormEls() {
        return {
            titleEl: document.getElementById('create-version-title'),
            saveBtn: document.getElementById('btn-save-version'),
            nameInput: document.getElementById('new-version-name'),
            baseSelect: document.getElementById('new-version-base'),
            typeSelect: document.getElementById('new-version-type'),
            accentSelect: document.getElementById('new-version-accent')
        };
    }

    function setVersionFormMode(mode, currentName = null) {
        const { titleEl, saveBtn } = getCreateFormEls();
        versionFormMode = mode;
        editingVersionName = mode === 'edit' ? currentName : null;
        if (titleEl) titleEl.textContent = mode === 'edit' ? 'Edit Version Options' : 'Create New Version';
        if (saveBtn) saveBtn.textContent = mode === 'edit' ? 'Save Changes' : 'Save';
    }

    function resetCreateVersionForm() {
        const { nameInput, typeSelect, accentSelect } = getCreateFormEls();
        if (nameInput) nameInput.value = '';
        if (typeSelect) typeSelect.value = 'vanilla';
        if (accentSelect && accentSelect.options.length > 0) accentSelect.selectedIndex = 0;
        setVersionFormMode('create');
    }

    function getUniqueVersionNameForEdit(baseName, excludedName) {
        const names = new Set(
            getVersionSelects()
                .flatMap(sel => Array.from(sel.options).map(o => o.value))
                .filter(name => name !== excludedName)
        );
        let attempt = baseName.slice(0, 15);
        if (!names.has(attempt)) return attempt;
        let i = 2;
        while (i < 100) {
            const suffix = ` ${i}`;
            const candidate = `${baseName.slice(0, Math.max(1, 15 - suffix.length))}${suffix}`;
            if (!names.has(candidate)) return candidate;
            i++;
        }
        return `${baseName.slice(0, 12)} ${Math.floor(Math.random() * 90 + 10)}`;
    }

    async function openEditVersionOptions(versionName, accentFallback) {
        const { nameInput, baseSelect, typeSelect, accentSelect } = getCreateFormEls();
        const existing = electronAvailable ? await ipcRenderer.invoke('get-settings', versionName) : {};
        const baseVersion = existing?.baseVersion || versionName;
        const customType = existing?.customType || 'vanilla';
        const accentColor = existing?.accentColor || accentFallback || '#ecc0ff';

        if (nameInput) nameInput.value = versionName;
        if (typeSelect) typeSelect.value = customType;
        if (accentSelect) accentSelect.value = accentColor;

        if (baseSelect) {
            const byBase = Array.from(baseSelect.options).find(opt => opt.dataset.baseVersion === baseVersion);
            if (byBase) baseSelect.value = byBase.value;
            else if (Array.from(baseSelect.options).some(opt => opt.value === baseVersion)) baseSelect.value = baseVersion;
        }

        setVersionFormMode('edit', versionName);
        switchTab(btnInstances, createVersionView);
    }

    function addVersionToSelectors(name, isCustom = false, accentColor = '') {
        getVersionSelects().forEach(sel => {
            if (Array.from(sel.options).some(o => o.value === name)) return;
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = leanVersions.includes(name) ? `${name} Lean Client Old` : name;
            if (isCustom) {
                opt.dataset.custom = 'true';
                if (accentColor) opt.dataset.accent = accentColor;
            }
            sel.appendChild(opt);
        });
    }

    function showDeleteConfirm(versionName) {
        return new Promise(resolve => {
            if (!confirmDeleteModal || !confirmDeleteYes || !confirmDeleteNo || !confirmDeleteText) {
                resolve(false);
                return;
            }
            confirmDeleteText.textContent = `Delete custom version "${versionName}"? This is permanent.`;
            confirmDeleteModal.classList.remove('hidden');
            requestAnimationFrame(() => confirmDeleteModal.classList.add('visible'));

            let closed = false;
            const close = (result) => {
                if (closed) return;
                closed = true;
                confirmDeleteModal.classList.remove('visible');
                setTimeout(() => confirmDeleteModal.classList.add('hidden'), 260);
                confirmDeleteYes.removeEventListener('click', onYes);
                confirmDeleteNo.removeEventListener('click', onNo);
                confirmDeleteModal.removeEventListener('click', onBackdrop);
                resolve(result);
            };
            const onYes = () => close(true);
            const onNo = () => close(false);
            const onBackdrop = (event) => {
                if (event.target === confirmDeleteModal) close(false);
            };

            confirmDeleteYes.addEventListener('click', onYes);
            confirmDeleteNo.addEventListener('click', onNo);
            confirmDeleteModal.addEventListener('click', onBackdrop);
        });
    }

    async function renderFolderChildren(versionName, relPath, parentEl) {
        if (!electronAvailable || !parentEl) return;
        const entries = await ipcRenderer.invoke('list-instance-directory', { version: versionName, relPath });
        parentEl.innerHTML = '';

        const getDroppedPaths = (event) => Array.from(event.dataTransfer?.files || [])
            .map(file => file?.path)
            .filter(Boolean);

        entries.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'file-tree-item';

            const row = document.createElement('div');
            row.className = `file-tree-row ${entry.isDirectory ? 'folder' : 'file'}`;
            const rowLabel = document.createElement('span');
            rowLabel.textContent = entry.name;
            row.appendChild(rowLabel);
            item.appendChild(row);

            if (entry.isDirectory) {
                const childrenWrap = document.createElement('div');
                childrenWrap.className = 'file-tree-children';
                childrenWrap.dataset.loaded = 'false';

                const childrenInner = document.createElement('div');
                childrenInner.className = 'file-tree-children-inner';
                childrenWrap.appendChild(childrenInner);

                row.addEventListener('click', async () => {
                    const expanded = childrenWrap.classList.contains('expanded');
                    if (!expanded) {
                        childrenWrap.classList.add('expanded');
                        if (childrenWrap.dataset.loaded !== 'true') {
                            await renderFolderChildren(versionName, entry.relPath, childrenInner);
                            childrenWrap.dataset.loaded = 'true';
                        }
                    } else {
                        childrenWrap.classList.remove('expanded');
                    }
                });

                row.addEventListener('dragover', (event) => {
                    event.preventDefault();
                    row.classList.add('drag-over');
                });

                row.addEventListener('dragleave', () => {
                    row.classList.remove('drag-over');
                });

                row.addEventListener('drop', async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    row.classList.remove('drag-over');

                    const sourcePaths = getDroppedPaths(event);

                    if (!sourcePaths.length) return;

                    const uploaded = await copyDroppedFilesToFolder(versionName, entry.relPath, sourcePaths);
                    if (uploaded) {
                        if (childrenWrap.classList.contains('expanded')) {
                            await renderFolderChildren(versionName, entry.relPath, childrenInner);
                            childrenWrap.dataset.loaded = 'true';
                        }
                        await renderFolderChildren(versionName, relPath, parentEl);
                    }
                });

                item.appendChild(childrenWrap);
            } else {
                row.addEventListener('dragover', (event) => {
                    event.preventDefault();
                    row.classList.add('drag-over');
                });

                row.addEventListener('dragleave', () => {
                    row.classList.remove('drag-over');
                });

                row.addEventListener('drop', async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    row.classList.remove('drag-over');

                    const sourcePaths = getDroppedPaths(event);
                    if (!sourcePaths.length) return;

                    // Files cannot have children, so drop-to-file uploads into its parent directory.
                    const parentRelPath = entry.relPath.includes('/') ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/')) : '';
                    const uploaded = await copyDroppedFilesToFolder(versionName, parentRelPath, sourcePaths);
                    if (uploaded) await renderFolderChildren(versionName, relPath, parentEl);
                });

                row.addEventListener('click', async () => {
                    const res = await ipcRenderer.invoke('read-instance-file', { version: versionName, relPath: entry.relPath });
                    if (!res?.success) {
                        setStatus(`Failed to open ${entry.name}: ${res?.error || 'Unknown error'}`, 0);
                        return;
                    }

                    const content = typeof res.content === 'string' ? res.content : '';
                    editingFileState = { version: versionName, relPath: entry.relPath, fileName: entry.name };
                    if (fileEditorTitle) fileEditorTitle.textContent = entry.name;
                    if (fileEditorContent) fileEditorContent.value = content;
                    fileEditorModal?.classList.remove('hidden');
                    requestAnimationFrame(() => fileEditorModal?.classList.add('visible'));
                });
            }

            parentEl.appendChild(item);
        });
    }

    async function openInstanceFiles(versionName) {
        if (!instanceFilesOverlay || !instanceFilesTree) return;
        if (!electronAvailable) return;

        currentInstanceFilesVersion = versionName;
        instanceFilesOverlay.dataset.version = versionName;
        instanceFilesTitle.textContent = `Instance Files - ${versionName}`;
        instanceFilesTree.innerHTML = '';
        await renderFolderChildren(versionName, '', instanceFilesTree);
        instancesView.classList.add('files-open');
        instanceFilesOverlay.setAttribute('aria-hidden', 'false');
    }

    async function copyDroppedFilesToFolder(versionName, relPath, sourcePaths) {
        if (!electronAvailable || !Array.isArray(sourcePaths) || !sourcePaths.length) return;

        const result = await ipcRenderer.invoke('copy-files-into-instance-folder', {
            version: versionName,
            relPath,
            sourcePaths
        });

        if (!result?.success) {
            setStatus(`Upload failed: ${result?.error || 'Unknown error'}`, 0);
            return false;
        }

        await openInstanceFiles(versionName);
        setStatus(`Uploaded ${result.count || sourcePaths.length} file(s)`, 100);
        return true;
    }

    function closeInstanceFiles() {
        instancesView.classList.remove('files-open');
        instanceFilesOverlay?.setAttribute('aria-hidden', 'true');
        if (instanceFilesOverlay) delete instanceFilesOverlay.dataset.version;
        currentInstanceFilesVersion = null;
    }

    uploadInstanceFilesBtn?.addEventListener('click', async () => {
        if (!electronAvailable) return;
        const versionName = instanceFilesOverlay?.dataset?.version || currentInstanceFilesVersion;
        if (!versionName) {
            setStatus('No instance is currently open for uploads.', 0);
            return;
        }
        const result = await ipcRenderer.invoke('upload-instance-files', { version: versionName, relPath: '' });
        if (result?.success) {
            await openInstanceFiles(versionName);
        } else if (result?.error) {
            setStatus(`Upload failed: ${result.error}`, 0);
        }
    });

    instanceFilesOverlay?.addEventListener('dragover', (event) => {
        event.preventDefault();
    });

    instanceFilesOverlay?.addEventListener('drop', (event) => {
        // Prevent browser default file-open behavior when dropping in overlay whitespace.
        event.preventDefault();
    });

    instanceFilesTree?.addEventListener('dragover', (event) => {
        // Background drop zone should only activate for true empty space, not while hovering rows.
        if (event.target?.closest?.('.file-tree-row')) {
            instanceFilesTree.classList.remove('drag-over');
            return;
        }
        event.preventDefault();
        instanceFilesTree.classList.add('drag-over');
    });

    instanceFilesTree?.addEventListener('dragleave', (event) => {
        if (event.currentTarget === event.target) {
            instanceFilesTree.classList.remove('drag-over');
        }
    });

    instanceFilesTree?.addEventListener('drop', async (event) => {
        // Ignore background root-drop when hovering a row; row handlers own those cases.
        if (event.target?.closest?.('.file-tree-row')) return;
        event.preventDefault();
        event.stopPropagation();
        instanceFilesTree.classList.remove('drag-over');

        const sourcePaths = Array.from(event.dataTransfer?.files || []).map(file => file?.path).filter(Boolean);

        if (!sourcePaths.length) return;

        const versionName = instanceFilesOverlay?.dataset?.version || currentInstanceFilesVersion;
        if (!versionName) {
            setStatus('No instance is currently open for uploads.', 0);
            return;
        }
        await copyDroppedFilesToFolder(versionName, '', sourcePaths);
    });

    function removeVersionFromSelectors(name) {
        getVersionSelects().forEach(sel => {
            const opt = Array.from(sel.options).find(o => o.value === name);
            if (opt) opt.remove();
            if (sel.value === name) {
                sel.selectedIndex = 0;
                sel.dispatchEvent(new Event('change'));
            }
        });
    }

    function updateCustomOptionAccent(name, accentColor) {
        if (!accentColor) return;
        getVersionSelects().forEach(sel => {
            const opt = Array.from(sel.options).find(o => o.value === name);
            if (!opt) return;
            opt.dataset.custom = 'true';
            opt.dataset.accent = accentColor;
        });
    }

    function getUniqueVersionName(baseName) {
        const names = new Set(getVersionSelects().flatMap(sel => Array.from(sel.options).map(o => o.value)));
        let attempt = baseName.slice(0, 15);
        if (!names.has(attempt)) return attempt;
        let i = 2;
        while (i < 100) {
            const suffix = ` ${i}`;
            const candidate = `${baseName.slice(0, Math.max(1, 15 - suffix.length))}${suffix}`;
            if (!names.has(candidate)) return candidate;
            i++;
        }
        return `${baseName.slice(0, 12)} ${Math.floor(Math.random() * 90 + 10)}`;
    }

    async function createCustomVersionCard(versionName, accentColor, sourceVersionForDuplicate = null) {
        const grid = document.getElementById('custom-versions-list');
        const createBtn = document.getElementById('btn-create-version');

        if (!grid || !createBtn) return;
        if (Array.from(grid.querySelectorAll('.custom-version-card')).some(el => el.dataset.versionName === versionName)) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-version-card';
        wrapper.dataset.versionName = versionName;
        wrapper.style.setProperty('--custom-accent', accentColor);
        updateCustomOptionAccent(versionName, accentColor);

        const mainBtn = document.createElement('button');
        mainBtn.className = 'custom-version-main-btn';
        mainBtn.textContent = versionName;
        mainBtn.style.background = accentColor;
        mainBtn.style.color = 'white';
        mainBtn.onclick = () => {
            const sel = document.getElementById('version-select');
            sel.value = versionName;
            sel.dispatchEvent(new Event('change'));
            btnHome.click();
        };

        const actions = document.createElement('div');
        actions.className = 'custom-version-actions';

        const selectBtn = document.createElement('button');
        selectBtn.className = 'custom-version-action-btn';
        selectBtn.classList.add('custom-action-select');
        selectBtn.textContent = 'Select Version';
        selectBtn.onclick = (e) => {
            e.stopPropagation();
            const sel = document.getElementById('version-select');
            sel.value = versionName;
            sel.dispatchEvent(new Event('change'));
            btnHome.click();
        };

        const editOptionsBtn = document.createElement('button');
        editOptionsBtn.className = 'custom-version-action-btn';
        editOptionsBtn.classList.add('custom-action-edit-options');
        editOptionsBtn.textContent = 'Edit Options';
        editOptionsBtn.onclick = async (e) => {
            e.stopPropagation();
            await openEditVersionOptions(versionName, accentColor);
        };

        const editBtn = document.createElement('button');
        editBtn.className = 'custom-version-action-btn';
        editBtn.classList.add('custom-action-edit-files');
        editBtn.textContent = 'Edit Files';
        editBtn.onclick = async (e) => {
            e.stopPropagation();
            await openInstanceFiles(versionName);
        };

        const duplicateBtn = document.createElement('button');
        duplicateBtn.className = 'custom-version-action-btn';
        duplicateBtn.classList.add('custom-action-duplicate');
        duplicateBtn.textContent = 'Duplicate';
        duplicateBtn.onclick = async (e) => {
            e.stopPropagation();
            const newName = getUniqueVersionName(`${versionName} Copy`);
            let base = versionName;
            let type = 'vanilla';
            let accent = accentColor;

            if (electronAvailable) {
                const existing = await ipcRenderer.invoke('get-settings', sourceVersionForDuplicate || versionName);
                base = existing?.baseVersion || base;
                type = existing?.customType || type;
                accent = existing?.accentColor || accent;
                await ipcRenderer.invoke('save-settings', {
                    version: newName,
                    settings: {
                        ...existing,
                        isCustom: true,
                        baseVersion: base,
                        customType: type,
                        accentColor
                    }
                });
            }

            addVersionToSelectors(newName, true, accent);
            updateDropdownColors();
            await createCustomVersionCard(newName, accent, sourceVersionForDuplicate || versionName);
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'custom-version-action-btn delete';
        deleteBtn.classList.add('custom-action-delete');
        deleteBtn.textContent = 'Delete';
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            const confirmed = await showDeleteConfirm(versionName);
            if (!confirmed) return;

            if (electronAvailable) {
                await ipcRenderer.invoke('delete-custom-version', versionName);
            }

            removeVersionFromSelectors(versionName);
            wrapper.remove();
            updateDropdownColors();
        };

        actions.appendChild(selectBtn);
        actions.appendChild(editOptionsBtn);
        actions.appendChild(editBtn);
        actions.appendChild(duplicateBtn);
        actions.appendChild(deleteBtn);
        wrapper.appendChild(mainBtn);
        wrapper.appendChild(actions);
        grid.insertBefore(wrapper, createBtn);
    }

    function switchTab(btn, targetView) {
        const currentActive = currentPage || document.querySelector('.page-view.active-page') || homeView;

        topNavButtons.forEach(b => b?.classList.remove('active'));
        if (btn) btn.classList.add('active');
        positionNavIndicator(btn || document.querySelector('.nav-btn.active'));

        if (currentActive === targetView) return;

        const direction = getTransitionDirection(currentActive, targetView);
        const exitClass = direction === 'rtl' ? 'fade-left' : 'fade-right';
        const enterClass = direction === 'rtl' ? 'fade-right' : 'fade-left';

        // Prepare outgoing page: start from centered active state, then animate out.
        if (currentActive) {
            currentActive.classList.remove('fade-left', 'fade-right');
            currentActive.classList.add('active-page');
            void currentActive.offsetWidth;
            currentActive.classList.remove('active-page');
            currentActive.classList.add(exitClass);
        }

        // Prepare incoming page off-screen, then animate it into the active centered state.
        targetView.classList.remove('active-page', 'fade-left', 'fade-right');
        targetView.classList.add(enterClass);
        void targetView.offsetWidth;
        targetView.classList.remove('fade-left', 'fade-right');
        targetView.classList.add('active-page');

        currentPage = targetView;

        if (targetView !== instancesView) closeInstanceFiles();
    }

    btnSettings?.addEventListener('click', () => {
        switchTab(btnSettings, settingsView);
        loadInstanceSettings(); 
    });
    btnAbout?.addEventListener('click', () => {
        switchTab(btnAbout, aboutView);
    });
    btnInstances?.addEventListener('click', () => {
        switchTab(btnInstances, instancesView);
    });
    btnHome?.addEventListener('click', () => {
        switchTab(btnHome, homeView);
    });

    document.getElementById('btn-create-version')?.addEventListener('click', () => {
        resetCreateVersionForm();
        switchTab(btnInstances, createVersionView);
    });
    document.getElementById('btn-cancel-version')?.addEventListener('click', () => {
        resetCreateVersionForm();
        switchTab(btnInstances, instancesView);
    });

    document.getElementById('btn-save-version')?.addEventListener('click', async () => {
        const { nameInput, baseSelect, typeSelect, accentSelect } = getCreateFormEls();
        const sanitizedName = (nameInput?.value || '').trim().slice(0, 15);
        const requestedName = sanitizedName || (versionFormMode === 'edit' ? editingVersionName : 'Unnamed Version');
        const vName = versionFormMode === 'edit'
            ? getUniqueVersionNameForEdit(requestedName, editingVersionName)
            : getUniqueVersionName(requestedName);
        const selectedBase = baseSelect?.options[baseSelect.selectedIndex];
        const vBase = selectedBase?.dataset.baseVersion || baseSelect?.value;
        const vType = typeSelect?.value || 'vanilla';
        const accentColor = accentSelect?.value || '#ecc0ff';

        if (versionFormMode === 'edit' && editingVersionName && electronAvailable && vName !== editingVersionName) {
            await ipcRenderer.invoke('rename-custom-version', { oldVersion: editingVersionName, newVersion: vName });
        }

        if (electronAvailable) {
            const loadName = versionFormMode === 'edit' && editingVersionName ? editingVersionName : vName;
            const existing = await ipcRenderer.invoke('get-settings', loadName);
            await ipcRenderer.invoke('save-settings', {
                version: vName,
                settings: {
                    ...existing,
                    ram: existing?.ram || "4096",
                    preset: existing?.preset || "default",
                    jvmArgs: existing?.jvmArgs || [],
                    javaPath: existing?.javaPath || "",
                    playtime: existing?.playtime || 0,
                    isCustom: true,
                    baseVersion: vBase,
                    customType: vType,
                    accentColor
                }
            });
        }

        if (versionFormMode === 'edit' && editingVersionName && editingVersionName !== vName) {
            removeVersionFromSelectors(editingVersionName);
        }

        addVersionToSelectors(vName, true, accentColor);
        updateCustomOptionAccent(vName, accentColor);
        updateDropdownColors();

        if (versionFormMode === 'edit' && editingVersionName) {
            const oldCard = document.querySelector(`.custom-version-card[data-version-name="${editingVersionName}"]`);
            if (oldCard) oldCard.remove();
        }

        await createCustomVersionCard(vName, accentColor);

        if (versionFormMode === 'edit') {
            const versionSelect = document.getElementById('version-select');
            const settingsSelect = setInstanceSelect;
            if (versionSelect?.value === editingVersionName) versionSelect.value = vName;
            if (settingsSelect?.value === editingVersionName) settingsSelect.value = vName;
        }

        resetCreateVersionForm();
        switchTab(btnInstances, instancesView);
    });

    document.getElementById('new-version-name')?.addEventListener('input', (e) => {
        const value = (e.target.value || '').slice(0, 15);
        e.target.value = value;
    });

    if (electronAvailable) {
        const allSettings = await ipcRenderer.invoke('get-all-settings');
        Object.entries(allSettings || {}).forEach(async ([versionName, cfg]) => {
            if (!cfg || !cfg.isCustom) return;
            addVersionToSelectors(versionName, true, cfg.accentColor || '#ecc0ff');
            await createCustomVersionCard(versionName, cfg.accentColor || '#c000ff');
        });
        updateDropdownColors();
    }

    // Seed screenshots dropdown with all versions from the home page select (Lean Client Old + any others)
    if (screenshotsVersionSelect && versionSelect) {
        Array.from(versionSelect.options).forEach(opt => {
            if (!Array.from(screenshotsVersionSelect.options).some(o => o.value === opt.value)) {
                const newOpt = document.createElement('option');
                newOpt.value = opt.value;
                newOpt.textContent = opt.textContent;
                if (opt.dataset.custom) newOpt.dataset.custom = opt.dataset.custom;
                if (opt.dataset.accent) newOpt.dataset.accent = opt.dataset.accent;
                newOpt.style.color = opt.style.color;
                newOpt.style.fontWeight = opt.style.fontWeight;
                screenshotsVersionSelect.appendChild(newOpt);
            }
        });
    }

    closeInstanceFilesBtn?.addEventListener('click', closeInstanceFiles);
    function closeFileEditor() {
        if (!fileEditorModal) return;
        fileEditorModal.classList.remove('visible');
        setTimeout(() => fileEditorModal.classList.add('hidden'), 260);
    }

    fileEditorContent?.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const rect = fileEditorContent.getBoundingClientRect();
        const nearResizeHandle = event.clientX >= rect.right - 24 && event.clientY >= rect.bottom - 24;
        suppressFileEditorBackdropClick = nearResizeHandle;
    });

    window.addEventListener('mouseup', () => {
        if (!suppressFileEditorBackdropClick) return;
        requestAnimationFrame(() => {
            suppressFileEditorBackdropClick = false;
        });
    }, true);

    fileEditorClose?.addEventListener('click', closeFileEditor);
    fileEditorSave?.addEventListener('click', async () => {
        if (!electronAvailable || !editingFileState || !fileEditorContent) return;
        const result = await ipcRenderer.invoke('write-instance-file', {
            version: editingFileState.version,
            relPath: editingFileState.relPath,
            content: fileEditorContent.value
        });
        if (result?.success) {
            setStatus(`Saved ${editingFileState.fileName}`, 100);
            closeFileEditor();
        } else {
            setStatus(`Failed to save ${editingFileState.fileName}: ${result?.error || 'Unknown error'}`, 0);
        }
    });
    fileEditorModal?.addEventListener('click', (e) => {
        if (e.target !== fileEditorModal) return;
        if (suppressFileEditorBackdropClick) {
            suppressFileEditorBackdropClick = false;
            return;
        }
        closeFileEditor();
    });

    crashReportClose?.addEventListener('click', hideCrashReportModal);
    crashReportModal?.addEventListener('click', (event) => {
        if (event.target === crashReportModal) hideCrashReportModal();
    });

    // Copy Report button
    const crashReportCopy = document.getElementById('crash-report-copy');
    if (crashReportCopy && crashReportDetails) {
        crashReportCopy.addEventListener('click', () => {
            crashReportDetails.select();
            document.execCommand('copy');
            crashReportCopy.textContent = 'Copied!';
            setTimeout(() => { crashReportCopy.textContent = 'Copy Report'; }, 2000);
        });
    }

    loginModal?.addEventListener('click', (e) => {
        if (e.target === loginModal) showLoginModal(false);
    });
    loginModal?.querySelector('.login-card-wrapper')?.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    async function validateLaunch(version) {
        if (!electronAvailable) return null;

        // 1. RAM bounds check
        const ramValue = normalizeRamGb(setRam?.value || setRamSlider?.value || "4");
        if (ramValue < 0.5) return 'RAM allocation is too low. Set at least 0.5 GB.';
        if (Number.isFinite(totalSystemRamMb) && totalSystemRamMb > 0) {
            const ramMb = gbToMb(ramValue);
            if (ramMb > totalSystemRamMb - 512)
                return `RAM allocation (${formatRamGb(ramValue)} GB) exceeds available system memory.`;
        }

        // 2. Java path check (if provided)
        const javaPath = (setJavaPath?.value || '').trim();
        if (javaPath) {
            try {
                const result = await ipcRenderer.invoke('validate-java-path', javaPath);
                if (!result?.valid) return result?.error || 'The specified Java path is invalid.';
            } catch { /* main process may not support this yet, skip gracefully */ }
        }

        // 3. Custom JVM args sanity
        if (setPreset?.value === 'custom') {
            const raw = (setJvm?.value || '').trim();
            if (!raw) return 'Custom JVM preset is selected but no arguments are provided.';
            if (raw.length < 2 || !raw.startsWith('-'))
                return 'Custom JVM arguments appear invalid — they should start with a dash (e.g. -Xmx2G).';
        }

        // 4. Signed-in check
        if (!isSignedIn) return 'Please sign in before launching.';

        return null; // all clear
    }

    // 3D tilt — throttled to once per frame, cached rect, no forced layout
    let tiltRafId = null;
    let pendingTiltEvent = null;

    launchGroup?.addEventListener('mousemove', (event) => {
        pendingTiltEvent = event;
        if (tiltRafId) return;
        tiltRafId = requestAnimationFrame(() => {
            tiltRafId = null;
            const e = pendingTiltEvent;
            if (!e) return;
            pendingTiltEvent = null;
            if (!launchGroup._cachedRect) {
                launchGroup._cachedRect = launchGroup.getBoundingClientRect();
            }
            const rect = launchGroup._cachedRect;
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;
            launchGroup.style.transform = `perspective(1200px) rotateX(${-y / 18}deg) rotateY(${x / 18}deg) translateY(-2px)`;
        });
    });
    launchGroup?.addEventListener('mouseleave', () => {
        if (tiltRafId) { cancelAnimationFrame(tiltRafId); tiltRafId = null; }
        pendingTiltEvent = null;
        launchGroup._cachedRect = null;
        launchGroup.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg) translateY(0px)';
    });

    launchGroup?.addEventListener('click', async (e) => {
        if (!isSignedIn || e.target.closest('#version-select') || e.target.closest('#launch-profile-select')) return;
        const v = versionSelect?.value;
        if (!v) return;

        // --- Pre-launch validation ---
        const validationError = await validateLaunch(v);
        if (validationError) {
            setStatus(validationError, 0);
            statusBar.classList.add('visible');
            statusVersion.textContent = v;
            setTimeout(() => statusBar.classList.remove('visible'), 3000);
            return;
        }

        const selectedProfile = launchProfileSelect?.value || null;
        statusBar.classList.add('visible');
        statusVersion.textContent = selectedProfile ? `${v} (${formatProfileName(selectedProfile)})` : v;
        setStatus(`Preparing ${v}${selectedProfile ? ` (${formatProfileName(selectedProfile)})` : ''}...`, 0);
        const activeAccountId = authAccountsState?.activeAccountId || null;
        if (electronAvailable) await ipcRenderer.invoke('launch-game', { version: v, activeProfile: selectedProfile, accountId: activeAccountId });
    });

    cancelLaunchButton?.addEventListener('click', async () => {
        statusProgress.style.width = '0%'; statusText.textContent = 'Launch canceled.';
        if (electronAvailable) await ipcRenderer.invoke('cancel-launch');
        setTimeout(() => statusBar.classList.remove('visible'), 600);
    });

    userSection?.addEventListener('click', () => {
        if (loginModal?.classList.contains('visible')) {
            showLoginModal(false);
        } else {
            showLoginModal(true);
        }
    });
    playerHead?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (loginModal?.classList.contains('visible')) {
            showLoginModal(false);
        } else {
            showLoginModal(true);
        }
    });
    usernameEl?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (loginModal?.classList.contains('visible')) {
            showLoginModal(false);
        } else {
            showLoginModal(true);
        }
    });
    document.getElementById('login-cancel')?.addEventListener('click', () => showLoginModal(false));
    document.getElementById('login-now')?.addEventListener('click', async () => {
        if (!electronAvailable) return;
        const res = await ipcRenderer.invoke('login-account');
        if (res?.success) {
            const state = await refreshAuthAccounts();
            const activeAccount = syncActiveAccountDisplay(state, res.result.name, res.result.minecraftId) || res.result;
            updateProfileDisplay(activeAccount?.name || activeAccount?.accountName || res.result.name, activeAccount?.minecraftId || res.result.minecraftId);
            showLoginModal(false);
        } else if (!res?.cancelled) {
            alert(res?.error || 'Login failed. Check that Azure credentials are configured in the .env file.');
        }
    });

    document.getElementById('login-manage-accounts')?.addEventListener('click', async () => {
        await refreshAuthAccounts();
        mainView.classList.remove('active-view', 'fade-left', 'fade-right');
        mainView.classList.add('fade-left');
        manageView.classList.remove('fade-right', 'fade-left');
        manageView.classList.add('active-view');
    });

    document.getElementById('login-manage-back')?.addEventListener('click', () => {
        manageView.classList.remove('active-view', 'fade-left', 'fade-right');
        manageView.classList.add('fade-right');
        mainView.classList.remove('fade-left', 'fade-right');
        mainView.classList.add('active-view');
    });

    document.getElementById('login-cracked-btn')?.addEventListener('click', () => {
        // Hide main, show cracked
        mainView.classList.remove('active-view', 'fade-left', 'fade-right');
        mainView.classList.add('fade-left');
        crackedView.classList.remove('fade-right', 'fade-left');
        crackedView.classList.add('active-view');
    });
    document.getElementById('login-cracked-back')?.addEventListener('click', () => {
        // Hide cracked, show main
        crackedView.classList.remove('active-view', 'fade-left', 'fade-right');
        crackedView.classList.add('fade-right');
        mainView.classList.remove('fade-left', 'fade-right');
        mainView.classList.add('active-view');
    });
    document.getElementById('login-cracked-confirm')?.addEventListener('click', async () => {
        const name = crackedInput.value.replace(/\s+/g, '').trim();
        if (!name || !electronAvailable) return;
        const res = await ipcRenderer.invoke('login-offline', name);
        if (res?.success) {
            const state = await refreshAuthAccounts();
            syncActiveAccountDisplay(state, res.result.name, null);
            updateProfileDisplay(res.result.name, null);
            showLoginModal(false);
        }
    });

    crackedInput?.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\s+/g, '');
    });

    // --- Instance Search / Filter ---
    const instancesSearch = document.getElementById('instances-search');
    if (instancesSearch) {
        instancesSearch.addEventListener('input', () => {
            const query = (instancesSearch.value || '').trim().toLowerCase();
            const instanceView = document.getElementById('instances-view');
            if (!instanceView) return;

            const cards = instanceView.querySelectorAll('.lean-version-card, .custom-version-card');
            cards.forEach((card) => {
                const btn = card.querySelector('.lean-version-main-btn, .custom-version-main-btn');
                const text = (btn?.textContent || card.dataset?.versionName || '').toLowerCase();
                if (!query || text.includes(query)) {
                    card.classList.remove('version-card-hidden');
                } else {
                    card.classList.add('version-card-hidden');
                }
            });
        });
    }

    // Bubble animation — Canvas-based: zero DOM manipulation, single GPU texture
    const MAX_BUBBLES = 12;
    const SPAWN_INTERVAL_MS = 380;
    const SAFE = 80;
    const ATTR_RADIUS = 200;
    const ATTR_FORCE = 0.02;
    const ATTR_RADIUS_SQ = ATTR_RADIUS * ATTR_RADIUS;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '0';
    canvas.style.filter = 'blur(35px)';
    canvas.style.transition = 'opacity 0.8s ease';
    canvas.style.opacity = '1';
    layer.appendChild(canvas);

    // Remove old DOM bubble elements if any exist
    layer.querySelectorAll('.bubble').forEach(el => el.remove());

    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    const bubbles = [];
    const perfNow = performance.now.bind(performance);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let vw = window.innerWidth;
    let vh = window.innerHeight;
    let bubbleColor = 'rgba(139,92,246,0.22)';

    // Read CSS custom properties once, not per frame
    function readColors() {
        const style = getComputedStyle(document.documentElement);
        const bc = style.getPropertyValue('--bubble').trim();
        if (bc) bubbleColor = bc;
    }
    readColors();

    // Pre-rendered sprite cache — one offscreen canvas per rounded size bucket
    const spriteCache = new Map();
    function getSprite(r) {
        const key = Math.round(r / 20) * 20;
        let sprite = spriteCache.get(key);
        if (!sprite) {
            const d = key * 2;
            sprite = document.createElement('canvas');
            sprite.width = sprite.height = d;
            const sctx = sprite.getContext('2d', { alpha: true });
            sctx.fillStyle = bubbleColor;
            sctx.beginPath();
            sctx.arc(key, key, key, 0, Math.PI * 2);
            sctx.fill();
            spriteCache.set(key, sprite);
        }
        return sprite;
    }

    function invalidateSprites() {
        readColors();
        spriteCache.clear();
    }

    function resizeCanvas() {
        vw = window.innerWidth;
        vh = window.innerHeight;
        const MAX_DIM = 2560;
        const scale = Math.min(1, MAX_DIM / Math.max(vw * dpr, vh * dpr));
        canvas.width  = Math.round(vw * dpr * scale);
        canvas.height = Math.round(vh * dpr * scale);
        canvas.style.width  = vw + 'px';
        canvas.style.height = vh + 'px';
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
        invalidateSprites();
    }
    resizeCanvas();

    // Rebuild sprites when theme changes
    const themeObserver = new MutationObserver(() => invalidateSprites());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    window.addEventListener('resize', resizeCanvas, { passive: true });

    const mouse = { x: -9999, y: -9999 };
    let pointerDirty = false;
    window.addEventListener('pointermove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        pointerDirty = true;
    }, { passive: true });

    function createBubble(prefill) {
        const size = 120 + Math.random() * 220;
        return {
            size,
            x: SAFE + Math.random() * Math.max(vw - 2 * SAFE - size, 0),
            y: prefill ? Math.random() * vh : vh + 100 + Math.random() * 200,
            opacity: prefill ? 0.15 : 0,
            speed: 0.3 + Math.random() * 0.4,
            attractionTime: 0,
            // Precompute half-size and sprite once
            halfSize: size / 2,
            sprite: null
        };
    }

    // Pre-seed bubbles and pre-warm sprite cache for each
    for (let i = 0; i < MAX_BUBBLES; i++) {
        const b = createBubble(true);
        b.sprite = getSprite(b.halfSize);
        bubbles.push(b);
    }

    const CURSOR_PUSH_TIMEOUT = 5000;
    let lastSpawn = 0;
    let animId = null;

    function updateBubblesCanvas() {
        const tNow = perfNow();

        if (bubbles.length < MAX_BUBBLES && (tNow - lastSpawn) > SPAWN_INTERVAL_MS) {
            const b = createBubble(false);
            b.sprite = getSprite(b.halfSize);
            bubbles.push(b);
            lastSpawn = tNow;
        }

        const localMouse = pointerDirty ? { x: mouse.x, y: mouse.y } : mouse;
        pointerDirty = false;

        ctx.clearRect(0, 0, vw, vh);

        for (let i = bubbles.length - 1; i >= 0; i--) {
            const b = bubbles[i];
            b.y -= b.speed;

            const cx = b.x + b.halfSize;
            const cy = b.y + b.halfSize;
            const dx = localMouse.x - cx;
            const dy = localMouse.y - cy;

            // Manual sq-distance avoids Math.sqrt unless needed
            const dSq = dx * dx + dy * dy;

            if (dSq > 0 && dSq < ATTR_RADIUS_SQ) {
                b.attractionTime += 16;
                const overTime = b.attractionTime - CURSOR_PUSH_TIMEOUT;
                const stickiness = overTime > 0 ? Math.max(0, 1 - overTime / 1000) : 1;
                if (stickiness > 0) {
                    const d = Math.sqrt(dSq);
                    const f = (1 - (d / ATTR_RADIUS)) * ATTR_FORCE * stickiness;
                    b.x += dx * f;
                    b.y += dy * f;
                    if (d < 3) {
                        b.x = localMouse.x - b.halfSize;
                        b.y = localMouse.y - b.halfSize;
                    }
                }
            } else {
                b.attractionTime = Math.max(0, b.attractionTime - 32);
            }

            b.x = Math.max(SAFE, Math.min(vw - b.size - SAFE, b.x));

            b.opacity = (b.y > vh - 160 || b.y < 160)
                ? Math.max(0, b.opacity - 0.03)
                : Math.min(1, b.opacity + 0.03);

            ctx.globalAlpha = b.opacity;
            ctx.drawImage(b.sprite, cx - b.halfSize, cy - b.halfSize, b.size, b.size);

            if (b.y + b.size < -300) {
                bubbles[i] = createBubble(false);
            }
        }

        animId = requestAnimationFrame(updateBubblesCanvas);
    }

    // Crossfade configuration
    const XFADE_MS = 800; // CSS transition duration (must match style.transition)
    let bubbleFadeTimer = null;

    startBubbles = function() {
        // Cancel any pending fade-out so opacity doesn't snap back to 0
        if (bubbleFadeTimer) { clearTimeout(bubbleFadeTimer); bubbleFadeTimer = null; }
        canvas.style.opacity = '1';
        if (animId) return; // already running
        animId = requestAnimationFrame(updateBubblesCanvas);
    };

    stopBubbles = function() {
        canvas.style.opacity = '0';
        if (bubbleFadeTimer) clearTimeout(bubbleFadeTimer);
        bubbleFadeTimer = setTimeout(function() {
            if (animId) {
                cancelAnimationFrame(animId);
                animId = null;
            }
            ctx.clearRect(0, 0, vw, vh);
            bubbleFadeTimer = null;
        }, XFADE_MS);
    };

    // Start bubbles by default (loadGlobalSettings will crossfade to rain if needed)
    if (!document.documentElement.hasAttribute('data-simple')) startBubbles();

    // --- Rain animation effect (alternative to bubbles) ---
    //
    //  Architecture:
    //    Single canvas at body z-4, pointer-events:none, fixed fullscreen.
    //    z-4 sits behind #content (z-5) so top-bar pill buttons (z-100 inside
    //    #content's stacking context) always render above the clouds.
    //    Draw order (back→front): ambient glow → lightning bolts → rain → clouds.
    //    Clouds are behind UI chrome but visible through transparent areas.
    //
    let rainActive = false;
    let stormCanvas = null;
    let stormCtx = null;
    let stormAnimId = null;
    let stormFadeTimer = null;

    // -- Rain state (object-pooled, minimal) --
    const MAX_RAIN_DROPS = 80;
    const RAIN_WIND = -0.22;
    const RAIN_MIN_SPEED = 5;
    const RAIN_MAX_SPEED = 13;
    const rainDrops = new Array(MAX_RAIN_DROPS);
    let rainDropsLive = 0;

    // -- Lightning state --
    let lightningBolt = null;         // single bolt (points array) or null
    let lightningFlash = 0;           // 1→0 bright flash intensity
    let lightningAfterglow = 0;       // lingering glow that fades slowly
    let lightningTimer = 0;
    let nextLightningFrame = 0;
    let lightningOriginX = 0;
    let lightningOriginY = 0;

    // -- Cloud state --

    const CLOUD_FLOOR = 0.26;         // fraction of screen height: bottom of cloud deck

    // ── canvas setup ──────────────────────────────────────────────

    function buildStormCanvas() {
        if (stormCanvas) return;
        stormCanvas = document.createElement('canvas');
        stormCanvas.style.position = 'fixed';
        stormCanvas.style.inset = '0';
        stormCanvas.style.pointerEvents = 'none';
        stormCanvas.style.zIndex = '4';
        stormCanvas.style.opacity = '0';
        stormCanvas.style.transition = 'opacity 0.8s ease';
        document.body.appendChild(stormCanvas);
        stormCtx = stormCanvas.getContext('2d', { alpha: true, desynchronized: true });
        resizeStormCanvas();
    }

    function resizeStormCanvas() {
        if (!stormCanvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        stormCanvas.width  = Math.round(window.innerWidth  * dpr);
        stormCanvas.height = Math.round(window.innerHeight * dpr);
        stormCanvas.style.width  = window.innerWidth  + 'px';
        stormCanvas.style.height = window.innerHeight + 'px';
        stormCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── theme helpers ─────────────────────────────────────────────

    const RAIN_COLORS = {
        light:    'rgba(139,92,246,',
        pastel:   'rgba(168,140,220,',
        dark:     'rgba(168,85,247,',
        space:    'rgba(100,180,255,',
        midnight: 'rgba(100,150,220,',
        grass:    'rgba(100,180,100,',
        nether:   'rgba(220,80,80,',
        end:      'rgba(200,180,100,',
        bees:     'rgba(220,180,40,',
        deepdark: 'rgba(80,160,180,',
        cherry:   'rgba(240,150,180,',
        default:  'rgba(139,92,246,'
    };

    function getRainColor() {
        const theme = document.documentElement.getAttribute('data-theme') || 'light';
        return (RAIN_COLORS[theme] || RAIN_COLORS.default);
    }

    // Cached storm RGB + precomputed color partials (avoid per-frame string concat)
    let _sr = 139, _sg = 92, _sb = 246;
    let _sc0 = '139,92,246,';  // "r,g,b," for opacity suffix
    function refreshStormColors() {
        const m = getRainColor().match(/rgba\((\d+),(\d+),(\d+),/);
        _sr = m ? +m[1] : 139; _sg = m ? +m[2] : 92; _sb = m ? +m[3] : 246;
        _sc0 = `${_sr},${_sg},${_sb},`;
    }
    refreshStormColors();
    const stormThemeObs = new MutationObserver(refreshStormColors);
    stormThemeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // ── cloud layer (3 wide blur clouds, right→left drift) ───────

    let cloudTubes = [];              // each "tube" is one wide ellipse
    const CLOUD_COUNT = 3;
    const CLOUD_BLUR = 60;           // heavy blur = fewer clouds needed

    function seedClouds() {
        cloudTubes = [];
        const w = window.innerWidth;
        const h = window.innerHeight;
        const floor = h * CLOUD_FLOOR;
        for (let i = 0; i < CLOUD_COUNT; i++) {
            // Each cloud is a single very wide, slightly tall ellipse
            // Denser at the bottom of the cloud zone, lighter at top
            const baseY = floor * (0.25 + i * 0.28 + Math.random() * 0.1);
            cloudTubes.push({
                cx: (i / CLOUD_COUNT + Math.random() * 0.3) * w * 1.3 - w * 0.15,
                cy: baseY,
                rx: w * (0.6 + Math.random() * 0.4),   // 60-100% of screen width
                ry: 50 + Math.random() * 70,
                speed: -(0.15 + Math.random() * 0.5),   // right→left, slow
                alpha: 0.28 + ((i / CLOUD_COUNT) * 0.22)  // lower = more opaque
            });
        }
    }

    function drawClouds() {
        if (!stormCtx) return;
        const w = window.innerWidth;
        const r = _sr, g = _sg, b = _sb;

        // Drift right→left, wrap
        for (const c of cloudTubes) {
            c.cx += c.speed * 0.04;
            // Wrap: if center exits left, re-enter fully from right
            if (c.cx + c.rx < -100) c.cx = w + c.rx + 100;
        }

        stormCtx.save();
        stormCtx.filter = `blur(${CLOUD_BLUR}px)`;

        // Lower clouds paint last (on top)
        cloudTubes.sort((a, b) => a.cy - b.cy);

        for (const c of cloudTubes) {
            const grad = stormCtx.createRadialGradient(c.cx, c.cy - c.ry * 0.15, 0, c.cx, c.cy, c.rx);
            grad.addColorStop(0,    `rgba(${r},${g},${b},${c.alpha.toFixed(3)})`);
            grad.addColorStop(0.5,  `rgba(${r},${g},${b},${(c.alpha * 0.5).toFixed(3)})`);
            grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
            stormCtx.fillStyle = grad;
            stormCtx.beginPath();
            stormCtx.ellipse(c.cx, c.cy, c.rx, c.ry, 0, 0, Math.PI * 2);
            stormCtx.fill();
        }

        stormCtx.restore();

        // Solid ceiling band — fully opaque at very top
        stormCtx.save();
        stormCtx.filter = `blur(${(CLOUD_BLUR * 0.4).toFixed(0)}px)`;
        const ch = window.innerHeight * CLOUD_FLOOR * 0.3;
        const cg = stormCtx.createLinearGradient(0, 0, 0, ch);
        cg.addColorStop(0,    `rgba(${r},${g},${b},0.95)`);
        cg.addColorStop(0.6,  `rgba(${r},${g},${b},0.4)`);
        cg.addColorStop(1,    `rgba(${r},${g},${b},0)`);
        stormCtx.fillStyle = cg;
        stormCtx.fillRect(0, 0, w, ch);
        stormCtx.restore();
    }

    // ── lightning (themed, midpoint-displacement fractal) ─────────

    function midpointDisplace(p1, p2, spread) {
        return {
            x: (p1.x + p2.x) / 2 + (Math.random() - 0.5) * spread,
            y: (p1.y + p2.y) / 2 + (Math.random() - 0.5) * spread * 0.6
        };
    }

    function subdivide(pts, spread, depth) {
        if (depth <= 0 || pts.length < 2) return pts;
        const r = [];
        for (let i = 0; i < pts.length - 1; i++) {
            r.push(pts[i], midpointDisplace(pts[i], pts[i + 1], spread));
        }
        r.push(pts[pts.length - 1]);
        return subdivide(r, spread * 0.55, depth - 1);
    }

    function generateBoltPoints(startX, startY) {
        const h = window.innerHeight;
        const endY = startY + (h - startY) * (0.4 + Math.random() * 0.45);
        const endX = startX + (Math.random() - 0.5) * 220;
        let pts = subdivide([{ x: startX, y: startY }, { x: endX, y: endY }], 90, 5);
        const branches = [];
        const branchCount = 1 + Math.floor(Math.random() * 3);
        for (let b = 0; b < branchCount; b++) {
            const fi = 2 + Math.floor(Math.random() * (pts.length - 4));
            if (fi >= pts.length) continue;
            const f = pts[fi];
            const beY = f.y + (endY - f.y) * (0.25 + Math.random() * 0.5);
            const beX = f.x + (Math.random() - 0.5) * 160;
            branches.push(subdivide([{ x: f.x, y: f.y }, { x: beX, y: beY }], 45, 3));
        }
        return { main: pts, branches };
    }

    function triggerLightning() {
        const floor = window.innerHeight * CLOUD_FLOOR;
        lightningOriginY = floor * (0.12 + Math.random() * 0.58);
        lightningOriginX = window.innerWidth * (0.1 + Math.random() * 0.8);
        lightningBolt = generateBoltPoints(lightningOriginX, lightningOriginY);
        lightningFlash = 1.0;
        lightningAfterglow = 0.7;
        lightningTimer = 0;
        nextLightningFrame = Math.floor((120 + Math.random() * 420) / 16.67);
    }

    function drawLightning() {
        if (!stormCtx || !lightningBolt) return;
        const bolts = [lightningBolt.main, ...lightningBolt.branches];
        stormCtx.lineCap = 'round';
        stormCtx.lineJoin = 'round';
        stormCtx.shadowColor = `rgba(${_sc0}0.85)`;

        for (let i = 0; i < bolts.length; i++) {
            const pts = bolts[i];
            if (!pts || pts.length < 2) continue;
            const isMain = (i === 0);
            const alpha = isMain
                ? Math.min(1, lightningFlash * 1.1 + lightningAfterglow * 0.65)
                : Math.min(1, lightningFlash * 0.6  + lightningAfterglow * 0.35);
            if (alpha <= 0.005) continue;
            const w = isMain ? 2.2 : 1.0;

            // Outer glow — themed
            stormCtx.shadowBlur = isMain ? 22 : 12;
            stormCtx.strokeStyle = `rgba(${_sc0}${(alpha * 0.55).toFixed(3)})`;
            stormCtx.lineWidth = w * 5;
            stormCtx.beginPath();
            stormCtx.moveTo(pts[0].x, pts[0].y);
            for (let j = 1; j < pts.length; j++) stormCtx.lineTo(pts[j].x, pts[j].y);
            stormCtx.stroke();

            // Core bolt — bright tint
            const rc = Math.min(255, _sr + 80), gc = Math.min(255, _sg + 80), bc = Math.min(255, _sb + 80);
            stormCtx.shadowBlur = isMain ? 10 : 5;
            stormCtx.strokeStyle = `rgba(${rc},${gc},${bc},${(alpha * 0.95).toFixed(3)})`;
            stormCtx.lineWidth = w;
            stormCtx.beginPath();
            stormCtx.moveTo(pts[0].x, pts[0].y);
            for (let j = 1; j < pts.length; j++) stormCtx.lineTo(pts[j].x, pts[j].y);
            stormCtx.stroke();
        }

        stormCtx.shadowBlur = 0;
        stormCtx.shadowColor = 'transparent';

        // Origin flare
        if (lightningFlash > 0.15) {
            const rf = Math.min(255, _sr + 100), gf = Math.min(255, _sg + 100), bf = Math.min(255, _sb + 100);
            const fg = stormCtx.createRadialGradient(lightningOriginX, lightningOriginY, 0, lightningOriginX, lightningOriginY, 55);
            fg.addColorStop(0,    `rgba(${rf},${gf},${bf},${(lightningFlash * 0.75).toFixed(3)})`);
            fg.addColorStop(0.3,  `rgba(${_sc0}${(lightningFlash * 0.4).toFixed(3)})`);
            fg.addColorStop(1,    `rgba(${_sc0}0)`);
            stormCtx.fillStyle = fg;
            stormCtx.beginPath();
            stormCtx.arc(lightningOriginX, lightningOriginY, 55, 0, Math.PI * 2);
            stormCtx.fill();
        }
    }

    function drawAmbientGlow() {
        if (!stormCtx) return;
        const w = window.innerWidth, h = window.innerHeight;
        const floor = h * CLOUD_FLOOR;
        const glow = lightningFlash * 0.18 + lightningAfterglow * 0.06;
        if (glow > 0.003) {
            const y0 = floor * 0.95;
            const g = stormCtx.createLinearGradient(0, y0, 0, h);
            g.addColorStop(0,    `rgba(${_sc0}0)`);
            g.addColorStop(0.08, `rgba(${_sc0}${glow.toFixed(4)})`);
            g.addColorStop(1,    `rgba(${_sc0}${(glow * 0.5).toFixed(4)})`);
            stormCtx.fillStyle = g;
            stormCtx.fillRect(0, y0, w, h - y0);
        }
    }

    // ── rain drops (object-pooled, zero per-frame allocation) ─────

    // Re-init an existing drop object in-place — no allocation
    function initDrop(drop, startY) {
        const w = window.innerWidth;
        const speed = RAIN_MIN_SPEED + Math.random() * (RAIN_MAX_SPEED - RAIN_MIN_SPEED);
        const length = 10 + Math.random() * 24;
        drop.x     = Math.random() * w;
        drop.y     = startY != null ? startY : (window.innerHeight * CLOUD_FLOOR + Math.random() * 60);
        drop.speed = speed;
        drop.dx    = RAIN_WIND * speed * 0.6;
        drop.length = length;
        drop.lenX  = RAIN_WIND * length * 0.7;
        drop.width = 0.4 + Math.random() * 1.2;
        drop.alpha = 0.16 + Math.random() * 0.44;
        return drop;
    }

    function drawRain() {
        if (!stormCtx) return;
        const w = window.innerWidth, h = window.innerHeight;
        const floor = h * CLOUD_FLOOR;

        stormCtx.lineCap = 'round';
        for (let i = rainDropsLive - 1; i >= 0; i--) {
            const d = rainDrops[i];
            d.y += d.speed;
            d.x += d.dx;
            const fadeIn = Math.min(1, Math.max(0, d.y - floor) / 60);
            const alpha = d.alpha * fadeIn;
            if (alpha > 0.005) {
                stormCtx.strokeStyle = `rgba(${_sr},${_sg},${_sb},${alpha.toFixed(4)})`;
                stormCtx.lineWidth = d.width;
                stormCtx.beginPath();
                stormCtx.moveTo(d.x, d.y);
                stormCtx.lineTo(d.x + d.lenX, d.y + d.length);
                stormCtx.stroke();
            }
            if (d.y > h + 20) initDrop(d);  // recycle in-place
        }
        while (rainDropsLive < MAX_RAIN_DROPS) {
            rainDrops[rainDropsLive++] = initDrop({}, floor + Math.random() * (h - floor));
        }
    }

    // ── main animation loop ───────────────────────────────────────

    function updateStormCanvas() {
        if (!stormCtx || !rainActive) return;
        const w = window.innerWidth, h = window.innerHeight;
        stormCtx.clearRect(0, 0, w, h);
        drawAmbientGlow();
        // Lightning
        lightningTimer++;
        if (!lightningBolt && lightningTimer >= nextLightningFrame) triggerLightning();
        if (lightningBolt) {
            drawLightning();
            lightningFlash = Math.max(0, lightningFlash - 0.06);
            lightningAfterglow = Math.max(0, lightningAfterglow - 0.004);
            if (lightningFlash <= 0.01 && lightningAfterglow <= 0.01) { lightningBolt = null; lightningTimer = 0; }
        }
        drawRain();
        drawClouds();
        stormAnimId = requestAnimationFrame(updateStormCanvas);
    }

    // ── public API ────────────────────────────────────────────────

    startRain = function () {
        if (stormFadeTimer) { clearTimeout(stormFadeTimer); stormFadeTimer = null; }
        if (!rainActive) {
            rainActive = true;
            buildStormCanvas();
            resizeStormCanvas();
            seedClouds();
            refreshStormColors();
            rainDropsLive = 0;
            lightningBolt = null;
            lightningFlash = lightningAfterglow = lightningTimer = 0;
            nextLightningFrame = 60;
            const hh = window.innerHeight, floor = hh * CLOUD_FLOOR, range = hh - floor;
            for (let i = 0; i < MAX_RAIN_DROPS; i++) {
                rainDrops[i] = initDrop({}, floor + range * (i / MAX_RAIN_DROPS));
            }
            rainDropsLive = MAX_RAIN_DROPS;
            stormAnimId = requestAnimationFrame(updateStormCanvas);
        }
        if (stormCanvas) stormCanvas.style.opacity = '1';
    };

    stopRain = function () {
        if (stormCanvas) stormCanvas.style.opacity = '0';
        if (stormFadeTimer) clearTimeout(stormFadeTimer);
        stormFadeTimer = setTimeout(function () {
            rainActive = false;
            lightningBolt = null;
            lightningFlash = lightningAfterglow = 0;
            if (stormAnimId) { cancelAnimationFrame(stormAnimId); stormAnimId = null; }
            if (stormCtx) stormCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
            rainDropsLive = 0;
            cloudTubes = [];
            stormFadeTimer = null;
        }, XFADE_MS);
    };

    applyAnimation = function (type) {
        if (type === 'rain') {
            if (!document.documentElement.hasAttribute('data-simple')) startRain();
            stopBubbles();
        } else {
            if (!document.documentElement.hasAttribute('data-simple')) startBubbles();
            stopRain();
        }
    };

    // Handle resize
    window.addEventListener('resize', () => {
        if (rainActive) {
            resizeStormCanvas();
            seedClouds();
        }
    }, { passive: true });

    // --- Auto-update event listeners ---
    if (typeof window.updateAPI !== 'undefined') {
        const updateModal = document.getElementById('update-modal');
        const updateVersion = document.getElementById('update-version');
        const updateReleaseNotes = document.getElementById('update-release-notes');
        const updateProgressContainer = document.getElementById('update-progress-container');
        const updateProgressFill = document.getElementById('update-progress-fill');
        const updateProgressText = document.getElementById('update-progress-text');
        const updateRestartBtn = document.getElementById('update-restart-btn');
        const updateDismissBtn = document.getElementById('update-dismiss-btn');

        let updateDownloaded = false;

        window.updateAPI.onUpdateAvailable((info) => {
            if (!updateModal || !updateVersion || !updateReleaseNotes) return;
            updateVersion.textContent = `Version ${info.version}`;
            if (info.releaseDate) {
                updateVersion.textContent += ` — ${new Date(info.releaseDate).toLocaleDateString()}`;
            }
            if (info.releaseNotes) {
                const notes = typeof info.releaseNotes === 'string'
                    ? info.releaseNotes
                    : (Array.isArray(info.releaseNotes)
                        ? info.releaseNotes.map(n => typeof n === 'object' ? n.note || '' : n).join('\n')
                        : '');
                updateReleaseNotes.textContent = notes;
            }
            if (updateProgressContainer) updateProgressContainer.style.display = 'flex';
            updateModal.classList.remove('hidden');
            requestAnimationFrame(() => updateModal.classList.add('visible'));
        });

        window.updateAPI.onDownloadProgress((progress) => {
            if (!updateProgressFill || !updateProgressText) return;
            updateProgressFill.style.width = `${progress.percent}%`;
            const mbDownloaded = (progress.transferred / (1024 * 1024)).toFixed(1);
            const mbTotal = (progress.total / (1024 * 1024)).toFixed(1);
            updateProgressText.textContent = `Downloading... ${progress.percent}% (${mbDownloaded} / ${mbTotal} MB)`;
        });

        window.updateAPI.onUpdateDownloaded((info) => {
            updateDownloaded = true;
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateVersion) updateVersion.textContent = `Version ${info.version} — Ready to install`;
            if (updateRestartBtn) {
                updateRestartBtn.disabled = false;
                updateRestartBtn.textContent = 'Restart and Apply Update';
            }
        });

        window.updateAPI.onUpdateError((error) => {
            console.error('[Update] Error:', error.message);
            if (updateProgressContainer) updateProgressContainer.style.display = 'none';
            if (updateVersion) updateVersion.textContent = 'Update failed. Please try again later.';
            if (updateRestartBtn) {
                updateRestartBtn.disabled = true;
                updateRestartBtn.textContent = 'Update Failed';
            }
        });

        updateRestartBtn?.addEventListener('click', () => {
            if (updateDownloaded && window.updateAPI) {
                window.updateAPI.restartAndInstall();
            }
        });

        updateDismissBtn?.addEventListener('click', () => {
            if (updateModal) {
                updateModal.classList.remove('visible');
                setTimeout(() => updateModal.classList.add('hidden'), 300);
            }
        });
    }
    
    showFpsWarningIfNeeded();
    
    // Screenshot Manager triggers
    btnScreenshots?.addEventListener('click', () => {
        if (screenshotsModal?.classList.contains('visible')) {
            closeScreenshotManager();
        } else {
            openScreenshotManager();
        }
    });
    screenshotsClose?.addEventListener('click', closeScreenshotManager);
    screenshotsOpenFolder?.addEventListener('click', openScreenshotsFolder);
    screenshotLightboxClose?.addEventListener('click', closeLightbox);
    screenshotLightboxCopy?.addEventListener('click', copyScreenshotToClipboard);
    screenshotLightboxDelete?.addEventListener('click', deleteCurrentScreenshot);
    screenshotLightboxPrev?.addEventListener('click', navigateLightbox(-1));
    screenshotLightboxNext?.addEventListener('click', navigateLightbox(1));
    screenshotLightbox?.addEventListener('click', (e) => { if (e.target === screenshotLightbox) closeLightbox(); });
    screenshotsModal?.addEventListener('click', (e) => { if (e.target === screenshotsModal) closeScreenshotManager(); });
    screenshotsVersionSelect?.addEventListener('change', () => loadScreenshots(screenshotsVersionSelect.value));
    screenshotsSortNewest?.addEventListener('click', () => { setSortMode('newest'); loadScreenshots(screenshotsVersionSelect?.value || versionSelect?.value); });
    screenshotsSortOldest?.addEventListener('click', () => { setSortMode('oldest'); loadScreenshots(screenshotsVersionSelect?.value || versionSelect?.value); });
    
    // Keyboard navigation for lightbox
    document.addEventListener('keydown', (e) => {
        if (!screenshotLightbox?.classList.contains('visible')) return;
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') navigateLightbox(-1)();
        if (e.key === 'ArrowRight') navigateLightbox(1)();
    });
}

function showFpsWarningIfNeeded() {
    if (!fpsWarningModal || !fpsWarningContinue || !fpsWarningDontAsk) return;
    
    const shouldShow = globShowFpsWarning ? globShowFpsWarning.checked : true;
    if (!shouldShow) return;
    
    fpsWarningModal.classList.remove('hidden');
    requestAnimationFrame(() => {
        fpsWarningModal.classList.add('visible');
    });
    
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        try {
            if (fpsWarningDontAsk.checked && globShowFpsWarning) {
                globShowFpsWarning.checked = false;
                saveGlobalSettings();
            }
        } catch (e) {
            console.error('Failed to save FPS warning preference:', e);
        }
        fpsWarningModal.classList.remove('visible');
        setTimeout(() => fpsWarningModal.classList.add('hidden'), 350);
        fpsWarningContinue.removeEventListener('click', close);
    };
    
    fpsWarningContinue.addEventListener('click', close);
}

// --- Screenshot Manager ---

async function openScreenshotManager(requestedVersion) {
    if (!screenshotsModal || !electronAvailable) return;
    
    // Close any other visible popups with their proper animations first
    if (loginModal?.classList.contains('visible')) hideModalGeneric(loginModal);
    if (fpsWarningModal?.classList.contains('visible')) hideModalGeneric(fpsWarningModal, 350);
    
    const version = requestedVersion || versionSelect?.value || '1.21.4';
    
    // Dropdown is already seeded at init; fallback only if still empty
    if (screenshotsVersionSelect && screenshotsVersionSelect.options.length === 0) {
        const opt = document.createElement('option');
        opt.value = version;
        opt.textContent = version;
        screenshotsVersionSelect.appendChild(opt);
    }
    if (screenshotsVersionSelect) screenshotsVersionSelect.value = version;
    
    await loadScreenshots(version);
    
    screenshotsModal.classList.remove('hidden');
    requestAnimationFrame(() => {
        screenshotsModal.classList.add('visible');
        // Initialize pill position after modal is visible (getBoundingClientRect needs rendered elements)
        requestAnimationFrame(() => setSortMode('newest'));
    });
}

function closeScreenshotManager() {
    screenshotsModal?.classList.remove('visible');
    setTimeout(() => screenshotsModal?.classList.add('hidden'), 300);
}

function setSortMode(mode) {
    const newestBtn = screenshotsSortNewest;
    const oldestBtn = screenshotsSortOldest;
    const pill = filterPillIndicator;
    if (!newestBtn || !oldestBtn || !pill) return;
    
    if (mode === 'newest') {
        newestBtn.classList.add('active');
        oldestBtn.classList.remove('active');
        // Animate pill to "Newest" button
        const rect = newestBtn.getBoundingClientRect();
        const parentRect = newestBtn.parentElement.getBoundingClientRect();
        pill.style.left = (rect.left - parentRect.left + 2) + 'px';
        pill.style.width = (rect.width - 4) + 'px';
    } else {
        oldestBtn.classList.add('active');
        newestBtn.classList.remove('active');
        // Animate pill to "Oldest" button
        const rect = oldestBtn.getBoundingClientRect();
        const parentRect = oldestBtn.parentElement.getBoundingClientRect();
        pill.style.left = (rect.left - parentRect.left + 2) + 'px';
        pill.style.width = (rect.width - 4) + 'px';
    }
}

async function openScreenshotsFolder() {
    const version = versionSelect?.value || '1.21.4';
    if (electronAvailable) {
        await ipcRenderer.invoke('open-screenshots-folder', version);
    }
}

// --- Screenshot lightbox navigation ---

let currentLightboxShot = null;
let lightboxShots = [];
let lightboxIndex = -1;

function navigateLightbox(direction) {
    return () => {
        if (!lightboxShots.length) return;
        lightboxIndex = (lightboxIndex + direction + lightboxShots.length) % lightboxShots.length;
        showLightboxShot(lightboxShots[lightboxIndex]);
    };
}

function showLightboxShot(shot) {
    if (!screenshotLightboxImg) return;
    currentLightboxShot = shot;
    screenshotLightboxImg.src = `file://${shot.path}`;
    if (screenshotLightboxName) {
        screenshotLightboxName.textContent = shot.name.replace(/\.(png|jpg|jpeg)$/i, '');
    }
    if (screenshotLightboxDate && shot.mtime) {
        screenshotLightboxDate.textContent = new Date(shot.mtime).toLocaleString();
    }
    screenshotLightbox.classList.add('visible');
}

function closeLightbox() {
    screenshotLightbox?.classList.remove('visible');
    currentLightboxShot = null;
}

async function copyScreenshotToClipboard() {
    if (!currentLightboxShot || !electronAvailable) return;
    try {
        leanAPI.copyImageFromPath(currentLightboxShot.path);
    } catch (e) {
        console.error('Failed to copy screenshot:', e);
    }
}

async function deleteCurrentScreenshot() {
    if (!currentLightboxShot || !electronAvailable) return;
    await ipcRenderer.invoke('delete-screenshot', currentLightboxShot.path);
    closeLightbox();
    openScreenshotManager();
}

function openLightbox(shot) {
    if (!screenshotLightbox || !screenshotLightboxImg) return;
    // Build navigation list from current grid
    lightboxShots = [];
    const thumbs = screenshotsGrid?.querySelectorAll('.screenshot-thumb');
    if (thumbs) {
        thumbs.forEach(t => {
            const idx = parseInt(t.dataset.index);
            if (!isNaN(idx) && allScreenshots && allScreenshots[idx]) {
                lightboxShots.push(allScreenshots[idx]);
            }
        });
    }
    lightboxIndex = lightboxShots.indexOf(shot);
    if (lightboxIndex < 0) lightboxIndex = 0;
    showLightboxShot(shot);
}

// Update loadScreenshots to store all screenshots for navigation
let allScreenshots = [];

async function loadScreenshots(version) {
    if (!screenshotsGrid) return;
    const screenshots = await ipcRenderer.invoke('list-screenshots', version);
    const sortNewest = screenshotsSortNewest?.classList.contains('active') !== false; // default true
    
    let sorted = [...(screenshots || [])];
    if (!sortNewest) sorted.reverse();
    
    allScreenshots = sorted;
    screenshotsGrid.innerHTML = '';
    if (!sorted.length) {
        screenshotsGrid.innerHTML = '<p class="screenshots-empty">No screenshots found for this version.<br><small>Take screenshots in-game with F2</small></p>';
        return;
    }
    
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = todayStart - 7 * 86400000;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    
    function getGroup(mtime) {
        if (mtime >= todayStart) return 'Today';
        if (mtime >= weekStart) return 'This Week';
        if (mtime >= monthStart) return 'This Month';
        return 'Older';
    }
    
    let lastGroup = null;
    sorted.forEach((shot, idx) => {
        const group = getGroup(shot.mtime);
        if (group !== lastGroup) {
            const label = document.createElement('div');
            label.className = 'screenshots-group-label';
            label.textContent = group;
            screenshotsGrid.appendChild(label);
            lastGroup = group;
        }
        
        const thumb = document.createElement('div');
        thumb.className = 'screenshot-thumb';
        thumb.dataset.index = idx;
        const img = document.createElement('img');
        img.src = `file://${shot.path}`;
        img.loading = 'lazy';
        const date = document.createElement('span');
        date.className = 'screenshot-date';
        date.textContent = shot.name.replace(/\.(png|jpg|jpeg)$/i, '');
        thumb.appendChild(img);
        thumb.appendChild(date);
        thumb.addEventListener('click', () => openLightbox(shot));
        screenshotsGrid.appendChild(thumb);
    });
}

// Detect DOM readiness — with <script type="module"> (deferred), DOMContentLoaded
// may have already fired before this file finishes loading. Use readyState check.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
} else {
    initUI(); // DOM already loaded, call immediately
}

function setupCustomSelects() {
    document.querySelectorAll('select').forEach(select => {
        if (select.dataset.customized) return;
        select.dataset.customized = 'true';
        select.style.display = 'none';

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-select';

        const proxyBtn = document.createElement('div');
        const computedStyle = window.getComputedStyle(select);
        
        proxyBtn.className = 'custom-select__button';
        proxyBtn.textContent = select.options[select.selectedIndex]?.text || '';
        if (select.options[select.selectedIndex]?.style?.color) {
            proxyBtn.style.color = select.options[select.selectedIndex].style.color;
        }
        
        // Copy computed sizes
        proxyBtn.style.padding = computedStyle.padding;
        proxyBtn.style.fontSize = computedStyle.fontSize;
        proxyBtn.style.fontFamily = computedStyle.fontFamily;
        if(select.id === 'version-select') proxyBtn.style.borderRadius = '16px';
        if(select.id === 'screenshots-version-select') proxyBtn.style.borderRadius = '999px';
        
        const list = document.createElement('div');
        list.className = 'custom-select__list';
        // Tag home-page dropdowns so their list options can match the larger button font
        if (select.id === 'version-select' || select.id === 'launch-profile-select') {
            list.classList.add('custom-select__list--home');
        }
        // Append list to body so it escapes all stacking contexts
        document.body.appendChild(list);

        function positionList() {
            const rect = proxyBtn.getBoundingClientRect();
            list.style.top = (rect.bottom + 8) + 'px';
            list.style.left = rect.left + 'px';
            list.style.width = rect.width + 'px';
        }

        function updateList() {
            list.innerHTML = '';
            for (let i = 0; i < select.options.length; i++) {
                const opt = select.options[i];
                const optDiv = document.createElement('div');
                optDiv.className = 'custom-select__option';
                if (select.selectedIndex === i) optDiv.dataset.selected = 'true';
                optDiv.textContent = opt.text;
                // Carry over inline color + weight from original option for theme-colored Lean versions
                const optColor = opt.style.color;
                const optWeight = opt.style.fontWeight;
                if (optColor) optDiv.style.color = optColor;
                if (optWeight === 'bold' || Number(optWeight) >= 600) optDiv.style.fontWeight = '700';
                optDiv.onclick = (e) => {
                    e.stopPropagation();
                    select.selectedIndex = i;
                    select.dispatchEvent(new Event('change'));
                    proxyBtn.textContent = opt.text;
                    list.classList.remove('visible');
                    wrapper.style.zIndex = '';
                };
                list.appendChild(optDiv);
            }
        }
        updateList();

        const observer = new MutationObserver(() => {
            updateList();
            const selOpt = select.options[select.selectedIndex];
            proxyBtn.textContent = selOpt?.text || '';
            if (selOpt?.style?.color) proxyBtn.style.color = selOpt.style.color; else proxyBtn.style.color = '';
        });
        observer.observe(select, { childList: true, subtree: true });

        select.addEventListener('change', () => {
            const selOpt = select.options[select.selectedIndex];
            proxyBtn.textContent = selOpt?.text || '';
            if (selOpt?.style?.color) proxyBtn.style.color = selOpt.style.color; else proxyBtn.style.color = '';
            Array.from(list.children).forEach((child, i) => {
                child.dataset.selected = (i === select.selectedIndex) ? 'true' : 'false';
            });
        });

        proxyBtn.onclick = (e) => {
            e.stopPropagation();
            const isVisible = list.classList.contains('visible');
            // close all lists & reset all wrapper z-indices
            document.querySelectorAll('.custom-select__list').forEach(l => l.classList.remove('visible'));
            document.querySelectorAll('.custom-select').forEach(w => w.style.zIndex = '');
            if (!isVisible) {
                positionList();
                list.classList.add('visible');
                wrapper.style.zIndex = '4100';
            }
        };

        // Reposition on scroll/resize
        window.addEventListener('scroll', () => { if (list.classList.contains('visible')) positionList(); }, true);
        window.addEventListener('resize', () => { if (list.classList.contains('visible')) positionList(); });

        wrapper.appendChild(proxyBtn);
        select.parentNode.insertBefore(wrapper, select.nextSibling);
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-select')) {
            document.querySelectorAll('.custom-select__list').forEach(l => l.classList.remove('visible'));
            document.querySelectorAll('.custom-select').forEach(w => w.style.zIndex = '');
        }
    });
}

// --- Global click-outside-to-close for all popups ---
// Clicks anywhere outside a modal card (except window controls) close the visible popup.
function hideModalGeneric(modal, delayMs = 260) {
    if (!modal || !modal.classList.contains('visible')) return;
    modal.classList.remove('visible');
    setTimeout(() => modal.classList.add('hidden'), delayMs);
}

document.addEventListener('mousedown', (e) => {
    // Never close modals when clicking window controls (close, min, max)
    if (e.target.closest('.window-controls')) return;
    // Don't close if clicking inside any modal card
    if (e.target.closest('.launcher-modal-card') ||
        e.target.closest('.screenshots-card') ||
        e.target.closest('.login-card-wrapper') ||
        e.target.closest('.fps-warning-card') ||
        e.target.closest('.update-modal-card') ||
        e.target.closest('.screenshot-lightbox')) return;
    // Don't close if clicking a custom select dropdown
    if (e.target.closest('.custom-select') || e.target.closest('.custom-select__list')) return;
    // Don't close if clicking the toggle buttons that manage these popups
    if (e.target.closest('#user-section')) return;
    if (e.target.closest('#btn-screenshots')) return;

    // Close any visible modal (skip confirm-delete: it has Promise logic)
    const updateModal = document.getElementById('update-modal');
    if (loginModal?.classList.contains('visible')) hideModalGeneric(loginModal);
    if (fpsWarningModal?.classList.contains('visible')) hideModalGeneric(fpsWarningModal, 350);
    if (screenshotsModal?.classList.contains('visible')) closeScreenshotManager();
    if (crashReportModal?.classList.contains('visible')) hideCrashReportModal();
    if (fileEditorModal?.classList.contains('visible')) closeFileEditor();
    if (updateModal?.classList.contains('visible')) hideModalGeneric(updateModal, 300);
    if (screenshotLightbox?.classList.contains('visible')) closeLightbox();
});

// setupCustomSelects — also needs the readyState guard
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupCustomSelects);
} else {
    setupCustomSelects();
}