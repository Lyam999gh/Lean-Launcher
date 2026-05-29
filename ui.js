let ipcRenderer = null, electronAvailable = false;
try { const electron = window.require?.('electron') || null; ipcRenderer = electron?.ipcRenderer || null; electronAvailable = Boolean(ipcRenderer?.invoke); } catch { electronAvailable = false; }

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

const globTheme = document.getElementById('global-theme'), globLang = document.getElementById('global-language'), globCloseOnBoot = document.getElementById('global-close-on-boot'), globSimpleMode = document.getElementById('global-simple-mode');
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
        status_start: "Press LAUNCH to start."
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
        status_start: "Presione JUGAR para comenzar."
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
        } else {
            document.documentElement.removeAttribute('data-simple');
        }
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
        simpleMode: Boolean(globSimpleMode?.checked)
    };
    document.documentElement.setAttribute('data-theme', g.theme);
    if (g.simpleMode) {
        document.documentElement.setAttribute('data-simple', 'true');
        stopBubbles();
    } else {
        document.documentElement.removeAttribute('data-simple');
        startBubbles();
    }
    applyTranslations();
    ipcRenderer.invoke('save-global-settings', g);
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
        if (report.jvmArgs) sections.push(`  JVM Args  : ${report.jvmArgs}`);
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
    setJvm.value = s.jvmArgs || ""; setJavaPath.value = s.javaPath || "";
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
        jvmArgs: setJvm.value,
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
        [versionSelect, setInstanceSelect].forEach(sel => {
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

    [versionSelect, setInstanceSelect].forEach(sel => {
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
        return [versionSelect, setInstanceSelect].filter(Boolean);
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
                    jvmArgs: existing?.jvmArgs || "",
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
            const jvmArgs = (setJvm?.value || '').trim();
            if (!jvmArgs) return 'Custom JVM preset is selected but no arguments are provided.';
            if (jvmArgs.length < 2 || !jvmArgs.startsWith('-'))
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
        if (!isSignedIn) return;
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

    userSection?.addEventListener('click', () => showLoginModal(true));
    playerHead?.addEventListener('click', () => showLoginModal(true));
    usernameEl?.addEventListener('click', () => showLoginModal(true));
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
    layer.appendChild(canvas);

    // Remove old DOM bubble elements if any exist
    layer.querySelectorAll('.bubble').forEach(el => el.remove());

    const ctx = canvas.getContext('2d', { alpha: false });
    const bubbles = [];
    const perfNow = () => performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let vw = window.innerWidth;
    let vh = window.innerHeight;
    let bubbleColor = 'rgba(139,92,246,0.12)';
    let bgColor = '#f5f5f7';

    // Read CSS custom properties once, not per frame
    function readColors() {
        const style = getComputedStyle(document.documentElement);
        const bc = style.getPropertyValue('--bubble').trim();
        const bg = style.getPropertyValue('--bg').trim();
        if (bc) bubbleColor = bc;
        if (bg) bgColor = bg;
    }
    readColors();

    // Pre-rendered sprite cache: render each bubble size ONCE to an offscreen canvas.
    // Eliminates 840 GPU gradient state mutations per frame (the Windows 20fps bottleneck).
    const spriteCache = new Map();
    function getSprite(r) {
        const key = Math.round(r / 20) * 20;
        let sprite = spriteCache.get(key);
        if (!sprite) {
            const d = key * 2;
            sprite = document.createElement('canvas');
            sprite.width = sprite.height = d;
            const sctx = sprite.getContext('2d');
            const grad = sctx.createRadialGradient(key, key, 0, key, key, key);
            grad.addColorStop(0, bubbleColor);
            grad.addColorStop(0.7, 'transparent');
            sctx.fillStyle = grad;
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
        // Cap internal canvas resolution: 4K at 2x DPR = 33M pixels/frame,
        // which overwhelms Windows GPU canvas 2D drivers. Linux handles it fine.
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

    // Rebuild gradients when theme changes (--bubble color switches)
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
        const size = 160 + Math.random() * 300;
        return {
            size,
            x: SAFE + Math.random() * Math.max(vw - 2 * SAFE - size, 0),
            y: prefill ? Math.random() * vh : vh + 100 + Math.random() * 200,
            opacity: prefill ? 0.15 : 0,
            speed: 0.3 + Math.random() * 0.4,
            attractionTime: 0
        };
    }

    for (let i = 0; i < MAX_BUBBLES; i++) bubbles.push(createBubble(true));

    const CURSOR_PUSH_TIMEOUT = 5000;
    let lastSpawn = 0;
    let animId = null;

    function updateBubblesCanvas() {
        const tNow = perfNow();

        if (bubbles.length < MAX_BUBBLES && (tNow - lastSpawn) > SPAWN_INTERVAL_MS) {
            bubbles.push(createBubble(false));
            lastSpawn = tNow;
        }

        const localMouse = pointerDirty ? { x: mouse.x, y: mouse.y } : mouse;
        pointerDirty = false;

        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, vw, vh);

        for (let i = bubbles.length - 1; i >= 0; i--) {
            const b = bubbles[i];
            b.y -= b.speed;

            const cx = b.x + b.size / 2;
            const cy = b.y + b.size / 2;
            const dx = localMouse.x - cx;
            const dy = localMouse.y - cy;
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
                        b.x = localMouse.x - b.size / 2;
                        b.y = localMouse.y - b.size / 2;
                    }
                }
            } else {
                b.attractionTime = Math.max(0, b.attractionTime - 32);
            }

            b.x = Math.max(SAFE, Math.min(vw - b.size - SAFE, b.x));

            b.opacity = (b.y > vh - 160 || b.y < 160)
                ? Math.max(0, b.opacity - 0.03)
                : Math.min(1, b.opacity + 0.03);

            // Draw with pre-rendered sprite — single GPU texture blit, zero gradient mutations
            const r = b.size / 2;
            ctx.globalAlpha = b.opacity;
            ctx.drawImage(getSprite(r), cx - r, cy - r, b.size, b.size);

            if (b.y + b.size < -50) {
                bubbles[i] = createBubble(false);
            }
        }

        animId = requestAnimationFrame(updateBubblesCanvas);
    }

    function startBubbles() {
        if (animId) return;
        animId = requestAnimationFrame(updateBubblesCanvas);
    }

    function stopBubbles() {
        if (animId) {
            cancelAnimationFrame(animId);
            animId = null;
        }
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, vw, vh);
    }

    // Start if not in simple mode
    if (!document.documentElement.hasAttribute('data-simple')) startBubbles();

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

    // --- FPS + stutter diagnostic ---
    const fpsEl = document.createElement('div');
    fpsEl.style.cssText = 'position:fixed;top:4px;right:8px;z-index:99999;font-family:monospace;font-size:11px;color:#0f0;background:rgba(0,0,0,0.8);padding:3px 7px;border-radius:4px;pointer-events:none;';
    document.body.appendChild(fpsEl);
    const ft = [];
    let ff = 0, fl = performance.now(), lf = performance.now();
    (function loop() {
        const n = performance.now(), d = n - lf; lf = n;
        ft.push(d); if (ft.length > 120) ft.shift();
        ff++;
        if (n - fl >= 500) {
            const fps = Math.round(ff / ((n - fl) / 1000));
            const avg = ft.reduce((a,b) => a+b, 0) / ft.length;
            const v = ft.length > 10 ? Math.round(Math.sqrt(ft.reduce((s,t) => s + (t-avg)*(t-avg), 0) / ft.length) * 10) / 10 : 0;
            fpsEl.style.color = v < 3 ? '#0f0' : v < 6 ? '#ff0' : '#f44';
            fpsEl.textContent = `${fps} FPS  stutter:${v}ms`;
            ff = 0; fl = n;
        }
        requestAnimationFrame(loop);
    })();
}

document.addEventListener('DOMContentLoaded', initUI);

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
        
        const list = document.createElement('div');
        list.className = 'custom-select__list';
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
document.addEventListener('DOMContentLoaded', setupCustomSelects);