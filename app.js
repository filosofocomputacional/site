/* ==========================================================================
   STATE MANAGEMENT & GLOBAL CONFIGURATIONS
   ========================================================================== */

let students = [];
let officialMask = {
    numQuestions: 10,
    numAlternatives: 5,
    answers: {} // e.g., { 1: 'A', 2: 'B', ... }
};

let settings = {
    storageType: 'local', // 'local' or 'supabase'
    supabaseUrl: '',
    supabaseAnonKey: ''
};

let activeStudentId = null;
let supabaseClient = null;

// Camera configuration
let currentStream = null;
let useBackCamera = true;

// OMR coordinate calculations configuration
// Percentages relative to the 4 corner alignment markers
const layoutConfig = {
    uStart: 0.12,      // Grid start horizontal
    uEnd: 0.88,        // Grid end horizontal
    vStart: 0.28,      // Grid start vertical (below header and student name)
    vEnd: 0.88,        // Grid end vertical (above footer)
    markerGuideTL: { x: 70, y: 70 },   // Guideline coordinates in a 1000x1000 square
    markerGuideTR: { x: 930, y: 70 },
    markerGuideBL: { x: 70, y: 930 },
    markerGuideBR: { x: 930, y: 930 },
    searchRadius: 70   // Size of search window (140x140 square centered at guide)
};

// Auto-run initialization on load
document.addEventListener("DOMContentLoaded", () => {
    initApp();
});

/* ==========================================================================
   INITIALIZATION & PERSISTENCE
   ========================================================================== */

async function initApp() {
    // 1. Load configuration and local state
    loadLocalStorageData();

    // 2. Initialize Supabase if configured
    if (settings.storageType === 'supabase' && settings.supabaseUrl && settings.supabaseAnonKey) {
        initSupabase();
    }

    // 3. Render Lucide icons
    lucide.createIcons();

    // 4. Bind event listeners
    bindEvents();

    // 5. Build official mask rows UI
    renderOfficialKeyCreator();

    // 6. Fetch/Refresh student lists
    await refreshStudentsData();
}

function loadLocalStorageData() {
    // Load official answers mask
    const savedMask = localStorage.getItem("gabascan_mask");
    if (savedMask) {
        officialMask = JSON.parse(savedMask);
        document.getElementById("numQuestions").value = officialMask.numQuestions;
        document.getElementById("numAlternatives").value = officialMask.numAlternatives;
    } else {
        // Pre-fill a default mask (e.g. all 'A')
        for (let i = 1; i <= 10; i++) {
            officialMask.answers[i] = 'A';
        }
    }

    // Load storage settings
    const savedSettings = localStorage.getItem("gabascan_settings");
    if (savedSettings) {
        settings = JSON.parse(savedSettings);
        // Set UI radios
        const radioLocal = document.querySelector('input[name="storageType"][value="local"]');
        const radioSupa = document.querySelector('input[name="storageType"][value="supabase"]');
        if (settings.storageType === 'supabase') {
            radioSupa.checked = true;
            radioSupa.closest('.radio-card').classList.add('active');
            radioLocal.closest('.radio-card').classList.remove('active');
            document.getElementById("supabaseConfigArea").classList.remove("hidden");
        }
        document.getElementById("supabaseUrl").value = settings.supabaseUrl || '';
        document.getElementById("supabaseAnonKey").value = settings.supabaseAnonKey || '';
    }

    // Load students from LocalStorage (fallback/primary)
    const savedStudents = localStorage.getItem("gabascan_students");
    if (savedStudents) {
        students = JSON.parse(savedStudents);
    }
}

function initSupabase() {
    try {
        if (window.supabase) {
            supabaseClient = window.supabase.createClient(settings.supabaseUrl, settings.supabaseAnonKey);
            updateStorageBadge(true);
        }
    } catch (err) {
        console.error("Erro ao inicializar Supabase:", err);
        updateStorageBadge(false, "Erro Conexão");
    }
}

function updateStorageBadge(connected, errorMsg = "") {
    const badge = document.getElementById("storageStatusBadge");
    const text = document.getElementById("storageStatusText");
    
    if (settings.storageType === 'supabase') {
        if (connected) {
            badge.className = "status-badge supabase-active";
            text.textContent = "Supabase Nuvem";
        } else {
            badge.className = "status-badge border-danger bg-danger-light text-danger";
            text.textContent = errorMsg || "Erro Nuvem";
        }
    } else {
        badge.className = "status-badge";
        text.textContent = "Local Storage";
    }
}

/* ==========================================================================
   DATA SYNC & REFRESH LOGIC
   ========================================================================== */

async function refreshStudentsData() {
    if (settings.storageType === 'supabase' && supabaseClient) {
        showLoadingState(true);
        try {
            const { data, error } = await supabaseClient
                .from("gabaritos_alunos")
                .select("*")
                .order("name", { ascending: true });

            if (error) throw error;

            if (data) {
                // Map database columns to local app camelCase model
                students = data.map(item => ({
                    id: item.id,
                    name: item.name,
                    status: item.status || 'Pendente',
                    score: item.score,
                    answers: item.answers,
                    scannedAt: item.scanned_at
                }));
                // Update LocalStorage cache
                localStorage.setItem("gabascan_students", JSON.stringify(students));
                updateStorageBadge(true);
            }
        } catch (err) {
            console.error("Erro ao sincronizar do Supabase:", err);
            updateStorageBadge(false, "Erro de Sinc.");
            // Keep local cached students list
        } finally {
            showLoadingState(false);
        }
    }
    renderStudentList();
}

async function saveStudentScore(studentId, score, answers) {
    const studentIndex = students.findIndex(s => s.id === studentId);
    if (studentIndex === -1) return;

    const timestamp = new Date().toISOString();
    students[studentIndex].status = 'Corrigido';
    students[studentIndex].score = score;
    students[studentIndex].answers = answers;
    students[studentIndex].scannedAt = timestamp;

    // Cache locally
    localStorage.setItem("gabascan_students", JSON.stringify(students));

    // Upload to cloud if using Supabase
    if (settings.storageType === 'supabase' && supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from("gabaritos_alunos")
                .upsert({
                    id: studentId,
                    name: students[studentIndex].name,
                    status: 'Corrigido',
                    score: score,
                    answers: answers,
                    scanned_at: timestamp
                });

            if (error) throw error;
        } catch (err) {
            console.error("Falha ao salvar nota no Supabase:", err);
            alert("Nota gravada localmente. Ocorreu um erro ao sincronizar na nuvem.");
        }
    }
    
    renderStudentList();
}

function showLoadingState(show) {
    const listContainer = document.getElementById("studentsList");
    if (show) {
        listContainer.innerHTML = `
            <div class="empty-state">
                <i data-lucide="loader-2" class="empty-icon animate-spin"></i>
                <h3>Sincronizando banco de dados...</h3>
                <p>Buscando lista atualizada do Supabase.</p>
            </div>
        `;
        lucide.createIcons();
    }
}

/* ==========================================================================
   UI BINDINGS & EVENT LISTENERS
   ========================================================================== */

function bindEvents() {
    // Nav Tabs switching
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(item => {
        item.addEventListener("click", () => {
            const targetTab = item.getAttribute("data-tab");
            
            navItems.forEach(nav => nav.classList.remove("active"));
            item.classList.add("active");

            document.querySelectorAll(".tab-content").forEach(tab => {
                tab.classList.remove("active");
            });
            document.getElementById(targetTab).classList.add("active");
            
            // Re-render UI pieces if needed
            if (targetTab === 'students-tab') {
                renderStudentList();
            }
        });
    });

    // Student Search filter
    document.getElementById("studentSearch").addEventListener("input", () => {
        renderStudentList();
    });

    // Modal Import triggers
    document.getElementById("btnOpenImport").addEventListener("click", () => openModal("importModal"));
    document.getElementById("btnEmptyStateImport").addEventListener("click", () => openModal("importModal"));
    document.getElementById("btnCloseImportModal").addEventListener("click", () => closeModal("importModal"));
    document.getElementById("btnCancelImport").addEventListener("click", () => closeModal("importModal"));
    document.getElementById("btnConfirmImport").addEventListener("click", handleNamesImport);

    // CSV File Upload Drag & Drop
    const dropZone = document.getElementById("csvDropZone");
    const fileInput = document.getElementById("csvFileInput");

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("dragover");
    });
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0) {
            handleCSVFile(e.dataTransfer.files[0]);
        }
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
            handleCSVFile(fileInput.files[0]);
        }
    });

    // CSV Results Export
    document.getElementById("btnExportCSV").addEventListener("click", handleExportCSV);

    // Add Individual Student modal
    document.getElementById("btnAddStudent").addEventListener("click", () => openModal("addStudentModal"));
    document.getElementById("btnCloseAddStudentModal").addEventListener("click", () => closeModal("addStudentModal"));
    document.getElementById("btnCancelAddStudent").addEventListener("click", () => closeModal("addStudentModal"));
    document.getElementById("btnSaveNewStudent").addEventListener("click", handleAddIndividualStudent);

    // Answer Mask controls
    document.getElementById("numQuestions").addEventListener("change", (e) => {
        officialMask.numQuestions = parseInt(e.target.value);
        renderOfficialKeyCreator();
    });
    document.getElementById("numAlternatives").addEventListener("change", (e) => {
        officialMask.numAlternatives = parseInt(e.target.value);
        renderOfficialKeyCreator();
    });
    document.getElementById("btnSaveMask").addEventListener("click", saveOfficialMask);
    document.getElementById("btnPrintBlankSheet").addEventListener("click", printBlankSheets);

    // Storage configs
    const storageRadios = document.querySelectorAll('input[name="storageType"]');
    storageRadios.forEach(radio => {
        radio.addEventListener("change", (e) => {
            document.querySelectorAll(".radio-card").forEach(c => c.classList.remove("active"));
            radio.closest(".radio-card").classList.add("active");
            
            if (e.target.value === "supabase") {
                document.getElementById("supabaseConfigArea").classList.remove("hidden");
            } else {
                document.getElementById("supabaseConfigArea").classList.add("hidden");
                settings.storageType = "local";
                localStorage.setItem("gabascan_settings", JSON.stringify(settings));
                updateStorageBadge(false);
                refreshStudentsData();
            }
        });
    });

    document.getElementById("btnTestSupabase").addEventListener("click", testSupabaseConnection);
    document.getElementById("btnSaveSupabase").addEventListener("click", saveSupabaseSettings);
    document.getElementById("btnClearLocalData").addEventListener("click", clearLocalData);

    // Camera Scan Modal controls
    document.getElementById("btnExitScanner").addEventListener("click", stopCameraAndClose);
    document.getElementById("btnToggleCamera").addEventListener("click", toggleCameraFacing);
    document.getElementById("btnCapturePhoto").addEventListener("click", processCapturedFrame);

    // Review Modal confirmation
    document.getElementById("btnCloseReviewModal").addEventListener("click", () => closeModal("reviewModal"));
    document.getElementById("btnRetryScan").addEventListener("click", () => {
        closeModal("reviewModal");
        openCameraScanner(activeStudentId);
    });
    document.getElementById("btnConfirmScore").addEventListener("click", () => {
        const scoreVal = parseInt(document.getElementById("reviewScoreValue").textContent.split("/")[0]);
        const questionItems = document.querySelectorAll(".review-q-item");
        
        // Grab values that were graded to store in JSON
        const answersGraded = {};
        questionItems.forEach(el => {
            const qNum = el.getAttribute("data-q");
            const scannedAns = el.getAttribute("data-ans");
            answersGraded[qNum] = scannedAns;
        });

        saveStudentScore(activeStudentId, scoreVal, answersGraded);
        closeModal("reviewModal");
    });
}

function openModal(id) {
    document.getElementById(id).classList.add("active");
}

function closeModal(id) {
    document.getElementById(id).classList.remove("active");
}

/* ==========================================================================
   STUDENT CARDS UI RENDERING
   ========================================================================== */

function renderStudentList() {
    const listElement = document.getElementById("studentsList");
    const emptyState = document.getElementById("studentsEmptyState");
    const searchQuery = document.getElementById("studentSearch").value.toLowerCase().trim();

    // Filter list
    const filtered = students.filter(student => student.name.toLowerCase().includes(searchQuery));

    // Update stats counters
    const totalCount = students.length;
    const gradedCount = students.filter(s => s.status === 'Corrigido').length;
    const pendingCount = totalCount - gradedCount;

    document.getElementById("statTotalStudents").textContent = totalCount;
    document.getElementById("statGradedStudents").textContent = gradedCount;
    document.getElementById("statPendingStudents").textContent = pendingCount;

    if (filtered.length === 0) {
        listElement.classList.add("hidden");
        emptyState.classList.remove("hidden");
        return;
    }

    emptyState.classList.add("hidden");
    listElement.classList.remove("hidden");

    listElement.innerHTML = "";
    filtered.forEach(student => {
        const initials = student.name.split(" ").slice(0, 2).map(n => n[0]).join("");
        const isGraded = student.status === 'Corrigido';
        const cardClass = isGraded ? "student-card graded" : "student-card";
        
        let statusBadgeHTML = `<span class="student-status status-lbl-pending"><i data-lucide="clock" style="width:12px;height:12px;"></i> Pendente</span>`;
        if (isGraded) {
            statusBadgeHTML = `<span class="student-status status-lbl-graded"><i data-lucide="check-circle" style="width:12px;height:12px;"></i> Nota: ${student.score || 0}/${officialMask.numQuestions}</span>`;
        }

        const card = document.createElement("div");
        card.className = cardClass;
        card.innerHTML = `
            <div class="student-card-info">
                <div class="student-avatar">${initials}</div>
                <div class="student-details">
                    <span class="student-name">${student.name}</span>
                    ${statusBadgeHTML}
                </div>
            </div>
            <button class="btn-scan" onclick="openCameraScanner('${student.id}')" title="Escanear Gabarito">
                <i data-lucide="camera"></i>
            </button>
        `;
        listElement.appendChild(card);
    });

    lucide.createIcons();
}

/* ==========================================================================
   CSV UPLOAD, PARSING AND DOWNLOAD ACTIONS
   ========================================================================== */

function handleAddIndividualStudent() {
    const nameInput = document.getElementById("newStudentName");
    const name = nameInput.value.trim();
    if (!name) return;

    const newStudent = {
        id: crypto.randomUUID(),
        name: name,
        status: 'Pendente',
        score: null,
        answers: null,
        scannedAt: null
    };

    students.push(newStudent);
    localStorage.setItem("gabascan_students", JSON.stringify(students));

    // Upload if online
    if (settings.storageType === 'supabase' && supabaseClient) {
        supabaseClient.from("gabaritos_alunos").insert({
            id: newStudent.id,
            name: newStudent.name,
            status: 'Pendente'
        }).then(({ error }) => {
            if (error) console.error("Falha ao salvar estudante individual:", error);
        });
    }

    nameInput.value = "";
    closeModal("addStudentModal");
    renderStudentList();
}

function handleNamesImport() {
    const textNames = document.getElementById("textNamesList").value.trim();
    if (!textNames) {
        alert("Nenhum nome inserido.");
        return;
    }

    const lines = textNames.split("\n");
    let count = 0;

    lines.forEach(line => {
        const name = line.trim();
        if (name.length > 2) {
            const isDuplicate = students.some(s => s.name.toLowerCase() === name.toLowerCase());
            if (!isDuplicate) {
                students.push({
                    id: crypto.randomUUID(),
                    name: name,
                    status: 'Pendente',
                    score: null,
                    answers: null,
                    scannedAt: null
                });
                count++;
            }
        }
    });

    if (count > 0) {
        localStorage.setItem("gabascan_students", JSON.stringify(students));
        
        // Sync full new list if Supabase connected
        if (settings.storageType === 'supabase' && supabaseClient) {
            syncAllLocalStudentsToCloud();
        }
        
        alert(`${count} alunos novos adicionados com sucesso!`);
        document.getElementById("textNamesList").value = "";
        closeModal("importModal");
        renderStudentList();
    } else {
        alert("Nenhum nome novo foi importado (nomes vazios ou já existentes).");
    }
}

function handleCSVFile(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const text = e.target.result;
        // Simple CSV parser supporting comma or semicolon separators
        const lines = text.split(/\r?\n/);
        let count = 0;

        lines.forEach((line, idx) => {
            if (!line.trim()) return;
            // Separate line by common csv operators
            const cells = line.split(/[;,]/);
            let name = cells[0].replace(/"/g, '').trim();

            // Detect and skip headers
            if (idx === 0 && (name.toLowerCase() === 'nome' || name.toLowerCase() === 'name' || name.toLowerCase() === 'aluno' || name.toLowerCase() === 'student')) {
                return;
            }

            if (name.length > 2) {
                const isDuplicate = students.some(s => s.name.toLowerCase() === name.toLowerCase());
                if (!isDuplicate) {
                    students.push({
                        id: crypto.randomUUID(),
                        name: name,
                        status: 'Pendente',
                        score: null,
                        answers: null,
                        scannedAt: null
                    });
                    count++;
                }
            }
        });

        if (count > 0) {
            localStorage.setItem("gabascan_students", JSON.stringify(students));
            
            if (settings.storageType === 'supabase' && supabaseClient) {
                syncAllLocalStudentsToCloud();
            }

            alert(`${count} alunos importados do CSV com sucesso!`);
            closeModal("importModal");
            renderStudentList();
        } else {
            alert("Nenhum aluno novo importado. O arquivo CSV pode estar vazio ou formatado incorretamente.");
        }
    };
    reader.readAsText(file);
}

async function syncAllLocalStudentsToCloud() {
    if (!supabaseClient) return;
    
    // Map list to cloud columns
    const payload = students.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        score: s.score,
        answers: s.answers,
        scanned_at: s.scannedAt
    }));

    try {
        const { error } = await supabaseClient
            .from("gabaritos_alunos")
            .upsert(payload);
        if (error) throw error;
        updateStorageBadge(true);
    } catch (err) {
        console.error("Falha ao enviar lista sincronizada:", err);
        updateStorageBadge(false, "Falha Upload");
    }
}

function handleExportCSV() {
    if (students.length === 0) {
        alert("Não há dados de alunos para exportar.");
        return;
    }

    // Build standard CSV string. Semicolon is widely default for Excel in Brazilian Portuguese locales
    let csvContent = "\uFEFF"; // UTF-8 BOM to preserve accents in MS Excel
    csvContent += "Nome;Status;Acertos;Total Questoes;Respostas Dadas;Data da Correcao\n";

    students.forEach(s => {
        const statusStr = s.status === 'Corrigido' ? 'Corrigido' : 'Pendente';
        const scoreStr = s.score !== null ? s.score : '-';
        const totalStr = officialMask.numQuestions;
        
        let answersStr = "";
        if (s.answers) {
            // Format answers map to readable string: "Q1:A|Q2:B"
            answersStr = Object.entries(s.answers)
                .map(([q, a]) => `Q${q}:${a}`)
                .join("|");
        } else {
            answersStr = "-";
        }

        const dateStr = s.scannedAt ? new Date(s.scannedAt).toLocaleString("pt-BR") : "-";

        csvContent += `"${s.name}";"${statusStr}";"${scoreStr}";"${totalStr}";"${answersStr}";"${dateStr}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `notas_gabaritos_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/* ==========================================================================
   OFFICIAL KEY / MASCARA DEFINITIONS
   ========================================================================== */

function renderOfficialKeyCreator() {
    const grid = document.getElementById("officialKeyGrid");
    grid.innerHTML = "";

    const numQs = officialMask.numQuestions;
    const numAlts = officialMask.numAlternatives;

    for (let q = 1; q <= numQs; q++) {
        // Find existing configured answer or fallback to 'A'
        if (!officialMask.answers[q]) {
            officialMask.answers[q] = 'A';
        }
        const activeAns = officialMask.answers[q];

        const row = document.createElement("div");
        row.className = "gabarito-row";
        
        let label = q.toString().padStart(2, '0');
        let optionsHTML = "";

        for (let a = 0; a < numAlts; a++) {
            const letter = String.fromCharCode(65 + a); // 'A', 'B', 'C'...
            const isSelected = activeAns === letter ? "selected" : "";
            optionsHTML += `
                <button class="option-btn ${isSelected}" onclick="setMaskQuestionAnswer(${q}, '${letter}')">${letter}</button>
            `;
        }

        row.innerHTML = `
            <div class="question-num">${label}</div>
            <div class="options-row">${optionsHTML}</div>
        `;
        grid.appendChild(row);
    }
}

window.setMaskQuestionAnswer = function(questionNum, answerLetter) {
    officialMask.answers[questionNum] = answerLetter;
    
    // Rerender row locally instead of full grid for smoother clicks
    renderOfficialKeyCreator();
};

function saveOfficialMask() {
    localStorage.setItem("gabascan_mask", JSON.stringify(officialMask));
    alert("Gabarito Oficial salvo com sucesso!");
}

/* ==========================================================================
   BLANK ANSWER SHEET PRINTING GENERATOR
   ========================================================================== */

function printBlankSheets() {
    const printableArea = document.getElementById("printableArea");
    printableArea.innerHTML = "";

    const numQs = officialMask.numQuestions;
    const numAlts = officialMask.numAlternatives;

    // We can generate multiple pages if needed, but here we generate a single page containing the blank sheet
    const page = document.createElement("div");
    page.className = "sheet-page";

    // Append 4 corners calibration dots
    page.innerHTML = `
        <div class="print-marker marker-tl"></div>
        <div class="print-marker marker-tr"></div>
        <div class="print-marker marker-bl"></div>
        <div class="print-marker marker-br"></div>

        <div class="sheet-header">
            <h1>FOLHA DE RESPOSTAS</h1>
            <p>Por favor, utilize caneta preta ou azul para preencher os círculos das respostas.</p>
        </div>

        <div class="sheet-fields">
            <div class="field-line">ALUNO: <div class="line"></div></div>
            <div class="field-line" style="width: 50%; margin-bottom:0;">TURMA: <div class="line"></div></div>
        </div>

        <div class="sheet-instructions">
            <h3>Instruções de Preenchimento:</h3>
            <p>Preencha completamente o círculo da sua alternativa escolhida. Não faça rasuras ou marcações fora do círculo.</p>
            <div class="demo-bubbles">
                <span>Correto:</span>
                <div class="demo-bubble filled">A</div>
                <span style="margin-left: 10px;">Incorreto:</span>
                <div class="demo-bubble">A</div>
                <div style="text-decoration: line-through; margin-left: 5px;">❌</div>
            </div>
        </div>
    `;

    // Divide questions into columns (up to 10 questions per column)
    const questionsContainer = document.createElement("div");
    questionsContainer.className = "sheet-questions-container";

    const numCols = Math.ceil(numQs / 10);
    for (let col = 0; col < numCols; col++) {
        const colEl = document.createElement("div");
        colEl.className = "sheet-column";

        const startIdx = col * 10 + 1;
        const endIdx = Math.min(startIdx + 9, numQs);

        for (let q = startIdx; q <= endIdx; q++) {
            const row = document.createElement("div");
            row.className = "sheet-question-row";
            
            let label = q.toString().padStart(2, '0');
            let optionsHTML = "";

            for (let a = 0; a < numAlts; a++) {
                const letter = String.fromCharCode(65 + a);
                optionsHTML += `<div class="sheet-option-circle">${letter}</div>`;
            }

            row.innerHTML = `
                <div class="sheet-q-num">${label}</div>
                <div class="sheet-options">${optionsHTML}</div>
            `;
            colEl.appendChild(row);
        }
        questionsContainer.appendChild(colEl);
    }

    page.appendChild(questionsContainer);

    // Add visual watermark footer
    const footerInfo = document.createElement("div");
    footerInfo.className = "sheet-footer-info";
    footerInfo.textContent = `GabaScan OMR Sheet • ${numQs} Questões • ${numAlts} Alternativas`;
    page.appendChild(footerInfo);

    printableArea.appendChild(page);

    // Trigger printing dialog
    window.print();
}

/* ==========================================================================
   STORAGE SETTINGS CONFIGURATION
   ========================================================================== */

async function testSupabaseConnection() {
    const url = document.getElementById("supabaseUrl").value.trim();
    const key = document.getElementById("supabaseAnonKey").value.trim();

    if (!url || !key) {
        alert("Preencha a URL e a Anon Key.");
        return;
    }

    try {
        const tempClient = window.supabase.createClient(url, key);
        // Ping table schema checking
        const { error } = await tempClient.from("gabaritos_alunos").select("id").limit(1);
        
        if (error) throw error;
        
        alert("Conexão estabelecida com sucesso! A tabela 'gabaritos_alunos' foi encontrada.");
    } catch (err) {
        console.error(err);
        alert("Erro de conexão. Verifique os dados inseridos e se a tabela 'gabaritos_alunos' foi criada corretamente no Supabase com permissões RLS públicas.");
    }
}

function saveSupabaseSettings() {
    const url = document.getElementById("supabaseUrl").value.trim();
    const key = document.getElementById("supabaseAnonKey").value.trim();

    if (!url || !key) {
        alert("Preencha a URL e a Anon Key.");
        return;
    }

    settings.storageType = "supabase";
    settings.supabaseUrl = url;
    settings.supabaseAnonKey = key;

    localStorage.setItem("gabascan_settings", JSON.stringify(settings));
    
    initSupabase();
    refreshStudentsData();
    alert("Configurações do Supabase aplicadas e salvas!");
}

function clearLocalData() {
    if (confirm("ATENÇÃO: Você tem certeza que deseja excluir todos os dados cadastrados neste dispositivo? Esta ação não pode ser desfeita.")) {
        students = [];
        localStorage.removeItem("gabascan_students");
        alert("Todos os dados locais foram excluídos.");
        renderStudentList();
    }
}

/* ==========================================================================
   CAMERA CONTROL FLOW
   ========================================================================== */

async function openCameraScanner(studentId) {
    activeStudentId = studentId;
    const student = students.find(s => s.id === studentId);
    if (!student) return;

    document.getElementById("scannerStudentName").textContent = student.name;
    openModal("cameraModal");

    // Initialize media constraints
    const constraints = {
        video: {
            facingMode: useBackCamera ? { exact: "environment" } : "user",
            width: { ideal: 1280 },
            height: { ideal: 720 }
        },
        audio: false
    };

    try {
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }
        
        // Attempt back camera
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        startVideoStream();
    } catch (err) {
        console.warn("Falha ao obter câmera traseira. Tentando qualquer câmera...", err);
        try {
            // Fallback: request any camera
            const fallbackConstraints = { video: true, audio: false };
            currentStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
            startVideoStream();
        } catch (fallbackErr) {
            console.error("Sem acesso à câmera:", fallbackErr);
            alert("Não foi possível acessar a câmera do dispositivo. Verifique as permissões de privacidade do navegador.");
            closeModal("cameraModal");
        }
    }
}

function startVideoStream() {
    const video = document.getElementById("cameraVideo");
    video.srcObject = currentStream;
    video.setAttribute("playsinline", true); // required for iOS safari
    video.play();
    
    // Start canvas alignment guide rendering loop
    requestAnimationFrame(renderScannerGuidesLoop);
}

function toggleCameraFacing() {
    useBackCamera = !useBackCamera;
    if (activeStudentId) {
        openCameraScanner(activeStudentId);
    }
}

function stopCameraAndClose() {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
    }
    closeModal("cameraModal");
}

/* ==========================================================================
   SCANNER GUIDELINE CANVAS RENDER LOOP
   ========================================================================== */

function renderScannerGuidesLoop() {
    const video = document.getElementById("cameraVideo");
    const canvas = document.getElementById("cameraOverlayCanvas");
    
    // If the scanner modal was closed, stop the frame loops
    if (!document.getElementById("cameraModal").classList.contains("active") || !video.srcObject) {
        return;
    }

    const ctx = canvas.getContext("2d");

    // Match overlay canvas coordinates to screen dimensions
    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate alignment box overlay dimensions (Square aligned inside container)
    const scanBoxSize = Math.min(canvas.width, canvas.height) * 0.85;
    const boxX = (canvas.width - scanBoxSize) / 2;
    const boxY = (canvas.height - scanBoxSize) / 2;

    // Draw dark transparent margins around search guidelines
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, canvas.width, boxY); // Top overlay
    ctx.fillRect(0, boxY + scanBoxSize, canvas.width, canvas.height - (boxY + scanBoxSize)); // Bottom
    ctx.fillRect(0, boxY, boxX, scanBoxSize); // Left
    ctx.fillRect(boxX + scanBoxSize, boxY, canvas.width - (boxX + scanBoxSize), scanBoxSize); // Right

    // Draw central border box frame
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX, boxY, scanBoxSize, scanBoxSize);

    // Draw 4 guide corners (where black sheet marks should match)
    // Map coordinate percentages relative to our layoutConfig: 5% padding.
    // So TL is at (boxX + 0.05*scanBoxSize, boxY + 0.05*scanBoxSize)
    const padding = 0.07;
    const corners = [
        { x: boxX + padding * scanBoxSize, y: boxY + padding * scanBoxSize }, // Top Left
        { x: boxX + (1 - padding) * scanBoxSize, y: boxY + padding * scanBoxSize }, // Top Right
        { x: boxX + padding * scanBoxSize, y: boxY + (1 - padding) * scanBoxSize }, // Bottom Left
        { x: boxX + (1 - padding) * scanBoxSize, y: boxY + (1 - padding) * scanBoxSize } // Bottom Right
    ];

    ctx.strokeStyle = "#fbbf24"; // Amber guideline color
    ctx.lineWidth = 4;
    
    corners.forEach(corner => {
        // Draw crosshair/target circles for scanning feedback alignment
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, 20, 0, 2 * Math.PI);
        ctx.stroke();

        ctx.fillStyle = "rgba(251, 191, 36, 0.2)";
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, 20, 0, 2 * Math.PI);
        ctx.fill();
    });

    requestAnimationFrame(renderScannerGuidesLoop);
}

/* ==========================================================================
   COMPUTER VISION OMR CORE ENGINE
   ========================================================================== */

function processCapturedFrame() {
    const video = document.getElementById("cameraVideo");
    
    // Check stream status
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
        alert("Aguardando carregamento da câmera...");
        return;
    }

    // Initialize invisible working canvas for image processing
    const procCanvas = document.createElement("canvas");
    procCanvas.width = 1000;
    procCanvas.height = 1000;
    const procCtx = procCanvas.getContext("2d");

    // Capture frames cropping a centered square to normalize camera aspect ratios
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const videoSquareSize = Math.min(vw, vh);
    const sx = (vw - videoSquareSize) / 2;
    const sy = (vh - videoSquareSize) / 2;

    procCtx.drawImage(video, sx, sy, videoSquareSize, videoSquareSize, 0, 0, 1000, 1000);

    // Run OMR detection
    const result = runOMRDetection(procCanvas);

    if (result.success) {
        // Stop camera stream on successful detection
        stopCameraAndClose();

        // Populate details into review confirmation modal
        document.getElementById("reviewStudentName").textContent = 
            students.find(s => s.id === activeStudentId).name;
        document.getElementById("reviewScoreValue").textContent = 
            `${result.score} / ${officialMask.numQuestions}`;
        
        // Show correct/failed badge background colors
        const badge = document.querySelector(".score-badge-large");
        const ratio = result.score / officialMask.numQuestions;
        if (ratio >= 0.6) {
            badge.className = "score-badge-large";
        } else {
            badge.className = "score-badge-large failed-score";
        }

        // Render processed visual frame overlays onto preview modal canvas
        renderProcessedVisualPreview(procCanvas, result);

        // Populate grading log table
        renderGradingDetailsList(result.answersScanned);

        openModal("reviewModal");
    } else {
        // OMR analysis failed, notify user to realign sheet
        const feedbackEl = document.getElementById("scannerFeedback");
        feedbackEl.textContent = `Erro: ${result.error}. Realinhe o papel.`;
        feedbackEl.style.backgroundColor = "var(--danger)";
        
        // Clear warning toast after 2.5 seconds
        setTimeout(() => {
            feedbackEl.textContent = "Alinhe os 4 cantos da folha com as marcações amarelas";
            feedbackEl.style.backgroundColor = "rgba(15, 23, 42, 0.85)";
        }, 2500);
    }
}

function runOMRDetection(canvas) {
    const ctx = canvas.getContext("2d");
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imgData.data;

    // Helper: get grayscale brightness (0-255)
    function getGray(x, y) {
        const idx = (y * canvas.width + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx+1];
        const b = pixels[idx+2];
        return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }

    // 1. Locate centroids of the 4 corner markers inside local search grids
    const searchRadius = layoutConfig.searchRadius;
    const guides = [
        { id: "TL", x: layoutConfig.markerGuideTL.x, y: layoutConfig.markerGuideTL.y },
        { id: "TR", x: layoutConfig.markerGuideTR.x, y: layoutConfig.markerGuideTR.y },
        { id: "BL", x: layoutConfig.markerGuideBL.x, y: layoutConfig.markerGuideBL.y },
        { id: "BR", x: layoutConfig.markerGuideBR.x, y: layoutConfig.markerGuideBR.y }
    ];

    const centroids = {};

    for (const guide of guides) {
        let sumX = 0;
        let sumY = 0;
        let count = 0;

        // Fetch contrast range in search region to create adaptive local thresholds
        let minB = 255;
        let maxB = 0;

        const xMin = Math.max(0, guide.x - searchRadius);
        const xMax = Math.min(canvas.width - 1, guide.x + searchRadius);
        const yMin = Math.max(0, guide.y - searchRadius);
        const yMax = Math.min(canvas.height - 1, guide.y + searchRadius);

        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                const gray = getGray(x, y);
                if (gray < minB) minB = gray;
                if (gray > maxB) maxB = gray;
            }
        }

        // Validate contrast. White paper to solid black circle requires significant amplitude range
        const contrast = maxB - minB;
        if (contrast < 70) {
            return { success: false, error: `Marcador ${guide.id} ausente ou pouca luz` };
        }

        // Adaptive threshold for the local region
        const threshold = minB + (contrast * 0.45);

        // Find centroid of dark blob in search box
        for (let y = yMin; y <= yMax; y++) {
            for (let x = xMin; x <= xMax; x++) {
                const gray = getGray(x, y);
                if (gray < threshold) {
                    sumX += x;
                    sumY += y;
                    count++;
                }
            }
        }

        // Ensure blob size corresponds roughly to printed marker sizes (ex: ~120px to ~1600px areas)
        if (count < 60 || count > 2500) {
            return { success: false, error: `Marcador ${guide.id} de tamanho inválido` };
        }

        centroids[guide.id] = {
            x: Math.round(sumX / count),
            y: Math.round(sumY / count)
        };
    }

    // Centroids extracted successfully
    const cTL = centroids["TL"];
    const cTR = centroids["TR"];
    const cBL = centroids["BL"];
    const cBR = centroids["BR"];

    // Helper: bilinear mapping interpolation
    function mapCoordinates(u, v) {
        const x = (1-u)*(1-v)*cTL.x + u*(1-v)*cTR.x + (1-u)*v*cBL.x + u*v*cBR.x;
        const y = (1-u)*(1-v)*cTL.y + u*(1-v)*cTR.y + (1-u)*v*cBL.y + u*v*cBR.y;
        return { x: Math.round(x), y: Math.round(y) };
    }

    // 2. Sample and detect fills for each question's alternatives
    const numQs = officialMask.numQuestions;
    const numAlts = officialMask.numAlternatives;
    const answersScanned = {};
    const optionPixelsData = {}; // Stores mapping points and filled metrics for drawings
    let score = 0;

    // Grid geometries formulas mapped directly from generator layout percentage variables:
    // Layout parameters matching coordinates relative to 4 printed markers
    const uStart = layoutConfig.uStart;
    const uEnd = layoutConfig.uEnd;
    const vStart = layoutConfig.vStart;
    const vEnd = layoutConfig.vEnd;

    const numCols = Math.ceil(numQs / 10);
    const colSpacing = numCols === 3 ? 0.06 : (numCols === 2 ? 0.08 : 0);
    const colWidth = (uEnd - uStart - ((numCols - 1) * colSpacing)) / numCols;

    for (let q = 1; q <= numQs; q++) {
        // Find column details
        const colIdx = Math.floor((q - 1) / 10);
        const rowIdx = (q - 1) % 10;

        const colUStart = uStart + colIdx * (colWidth + colSpacing);
        const uOptionsStart = colUStart + 0.22 * colWidth;
        const uOptionsStep = 0.78 * colWidth / (numAlts - 1);
        
        const v = vStart + rowIdx * ((vEnd - vStart) / 9);

        // Gather darkness averages
        const alternativesDarkness = {};
        const coordinatesMap = {};

        for (let a = 0; a < numAlts; a++) {
            const letter = String.fromCharCode(65 + a);
            const u = uOptionsStart + a * uOptionsStep;

            // Warp relative coordinate
            const coord = mapCoordinates(u, v);
            coordinatesMap[letter] = coord;

            // Sample circle radius (10 pixels) around centroid
            const radius = 10;
            let darkSum = 0;
            let pixelCount = 0;

            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx*dx + dy*dy <= radius*radius) {
                        const px = coord.x + dx;
                        const py = coord.y + dy;
                        if (px >= 0 && px < canvas.width && py >= 0 && py < canvas.height) {
                            darkSum += (255 - getGray(px, py));
                            pixelCount++;
                        }
                    }
                }
            }

            const avgDark = darkSum / pixelCount;
            alternativesDarkness[letter] = avgDark;
        }

        // OMR fill classification logic:
        // Sort alternatives from darkest to lightest
        const sortedAlts = Object.entries(alternativesDarkness)
            .sort((a, b) => b[1] - a[1]); // Descending

        const darkestOpt = sortedAlts[0][0];
        const darkestVal = sortedAlts[0][1];
        
        // Find background brightness baseline from the lightest option
        // The lightest options are white circles representing empty options
        const baselineVal = sortedAlts[numAlts - 1][1]; 

        let selectedAlternative = null; // Default unanswered

        // Threshold values: minimum 75 absolute darkness and at least 35 points contrast over background
        const hasMinContrast = (darkestVal - baselineVal) > 35;
        const hasMinDarkness = darkestVal > 75;

        if (hasMinContrast && hasMinDarkness) {
            // Check double markings
            // If the 2nd darkest alternative is also very dark and close to the first: invalid double answer
            const secondVal = sortedAlts[1][1];
            if (secondVal > 75 && (darkestVal - secondVal) < 25) {
                selectedAlternative = "DUPLO"; // Flagged double answer
            } else {
                selectedAlternative = darkestOpt;
            }
        } else {
            selectedAlternative = "BRANCO"; // Flagged empty answer
        }

        answersScanned[q] = selectedAlternative;

        // Cache details for rendering overlay coordinates
        optionPixelsData[q] = {
            coords: coordinatesMap,
            darknessMap: alternativesDarkness,
            selected: selectedAlternative,
            correct: officialMask.answers[q]
        };

        // Grade correctness
        if (selectedAlternative === officialMask.answers[q]) {
            score++;
        }
    }

    return {
        success: true,
        score: score,
        answersScanned: answersScanned,
        centroids: centroids,
        optionPixelsData: optionPixelsData
    };
}

/* ==========================================================================
   VISUAL CORRECTION OVERLAYS & PREVIEW RENDER
   ========================================================================== */

function renderProcessedVisualPreview(sourceCanvas, result) {
    const previewCanvas = document.getElementById("processedCanvasPreview");
    previewCanvas.width = sourceCanvas.width;
    previewCanvas.height = sourceCanvas.height;

    const ctx = previewCanvas.getContext("2d");
    
    // Draw raw source frame first
    ctx.drawImage(sourceCanvas, 0, 0);

    // 1. Draw Centroid targets crosses
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#2563eb"; // Accent blue
    
    for (const [id, point] of Object.entries(result.centroids)) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 20, 0, 2*Math.PI);
        ctx.stroke();

        ctx.fillStyle = "rgba(37, 99, 235, 0.3)";
        ctx.beginPath();
        ctx.arc(point.x, point.y, 20, 0, 2*Math.PI);
        ctx.fill();
        
        // Target label name
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 16px Outfit";
        ctx.fillText(id, point.x - 10, point.y - 28);
    }

    // 2. Draw answers bubbles highlighting color codes:
    // Green = Correct answer (scanned or expected)
    // Red = Selected incorrect answer
    // Gray/Yellow = unselected expected options
    const optionData = result.optionPixelsData;

    for (const [qNum, data] of Object.entries(optionData)) {
        const letters = Object.keys(data.coords);
        
        letters.forEach(letter => {
            const coord = data.coords[letter];
            const isCorrectExpected = data.correct === letter;
            const isSelectedByStudent = data.selected === letter;

            ctx.lineWidth = 3;

            if (isSelectedByStudent) {
                if (isCorrectExpected) {
                    // Correct answer chosen: Solid green outline, soft green fill
                    ctx.strokeStyle = "#10b981";
                    ctx.fillStyle = "rgba(16, 185, 129, 0.4)";
                    ctx.beginPath();
                    ctx.arc(coord.x, coord.y, 14, 0, 2*Math.PI);
                    ctx.stroke();
                    ctx.fill();
                } else {
                    // Wrong answer chosen: Solid red outline, soft red fill
                    ctx.strokeStyle = "#ef4444";
                    ctx.fillStyle = "rgba(239, 68, 68, 0.4)";
                    ctx.beginPath();
                    ctx.arc(coord.x, coord.y, 14, 0, 2*Math.PI);
                    ctx.stroke();
                    ctx.fill();
                }
            } else {
                if (isCorrectExpected) {
                    // Correct answer not chosen: Amber dashed outline to highlight expected target
                    ctx.strokeStyle = "#f59e0b";
                    ctx.beginPath();
                    ctx.arc(coord.x, coord.y, 14, 0, 2*Math.PI);
                    ctx.setLineDash([4, 4]);
                    ctx.stroke();
                    ctx.setLineDash([]); // Reset dash array
                } else {
                    // Empty options not chosen: simple light-gray thin circles
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
                    ctx.beginPath();
                    ctx.arc(coord.x, coord.y, 12, 0, 2*Math.PI);
                    ctx.stroke();
                }
            }
        });
    }
}

function renderGradingDetailsList(scannedAnswers) {
    const list = document.getElementById("reviewQuestionsList");
    list.innerHTML = "";

    const numQs = officialMask.numQuestions;

    for (let q = 1; q <= numQs; q++) {
        const expected = officialMask.answers[q];
        const studentAns = scannedAnswers[q];
        const isCorrect = expected === studentAns;
        
        let itemClass = isCorrect ? "review-q-item correct" : "review-q-item incorrect";
        let badgeHTML = "";

        if (isCorrect) {
            badgeHTML = `<span class="value-badge correct-ans">${studentAns}</span>`;
        } else {
            let labelText = studentAns;
            if (studentAns === 'DUPLO') labelText = "Duplo";
            if (studentAns === 'BRANCO') labelText = "Branco";
            
            const badgeClass = (studentAns === 'DUPLO' || studentAns === 'BRANCO') ? "value-badge blank-ans" : "value-badge incorrect-ans";
            badgeHTML = `
                <span class="${badgeClass}">${labelText}</span>
                <span style="font-size:10px; color:var(--secondary)">→</span>
                <span class="value-badge correct-ans">${expected}</span>
            `;
        }

        const item = document.createElement("div");
        item.className = itemClass;
        item.setAttribute("data-q", q);
        item.setAttribute("data-ans", studentAns);
        item.innerHTML = `
            <span class="q-name">Q${q.toString().padStart(2, '0')}</span>
            <div class="q-values">${badgeHTML}</div>
        `;
        list.appendChild(item);
    }
}
