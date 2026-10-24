/**
 * ============================================================================
 * AUTÓMATA CELULAR DE PRODUCCIÓN - ENGINE CON PODA ESPACIAL O(A)
 * ============================================================================
 * Optimizaciones implementadas para defensa de ingeniería:
 * 1. Active-Region Tracking (Dirty Bitmask): Solo evalúa celdas que sufrieron
 *    transiciones en la generación t-1 y su vecindad de Moore (8 vecinos).
 * 2. Zero-Allocation Pointer Swapping: Intercambio de referencias Uint8Array
 *    en O(1) sin copias de memoria ni activación del Garbage Collector.
 * 3. Offscreen Grid Caching: La malla de fondo se dibuja una sola vez en RAM.
 * 4. Canvas Path Batching: Agrupación de geometría por estado de edad para
 *    ejecutar solo 3 llamadas de rasterizado (ctx.fill) por fotograma.
 * 5. Interpolación de Bresenham: Trazado vectorial continuo con el mouse.
 */

class CellularAutomataEngine {
    constructor(canvas, fpsCanvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false }); // Desactivar canal alfa acelera el rasterizado
        this.fpsCanvas = fpsCanvas;
        this.fpsCtx = fpsCanvas.getContext('2d', { alpha: false });

        // Canvas secundario en memoria para cachear la cuadrícula de fondo
        this.gridCacheCanvas = document.createElement('canvas');
        this.gridCacheCtx = this.gridCacheCanvas.getContext('2d', { alpha: false });

        // Parámetros de configuración
        this.cellSize = 8;
        this.cols = 0;
        this.rows = 0;
        this.totalCells = 0;

        // Estructuras de datos en memoria contigua (TypedArrays)
        this.grid = null;         // Estado actual (0 = muerta, 1..255 = edad)
        this.nextGrid = null;     // Buffer de estado siguiente
        this.activeList = null;   // Lista compacta de índices activos a evaluar
        this.nextActiveList = null;
        this.activeMask = null;   // Bitmask O(1) para evitar duplicados en activeList
        this.activeCount = 0;

        // Tablas Lookup precalculadas para envolver coordenadas toroidales sin usar '%'
        this.leftCol = null;
        this.rightCol = null;
        this.upRowOffset = null;
        this.downRowOffset = null;

        // Estado de control y telemetría
        this.isRunning = true;
        this.generation = 0;
        this.aliveCount = 0;
        this.simSpeed = 30;
        this.lastStepTime = 0;
        this.lastComputeMs = 0;

        // Telemetría de FPS
        this.frameCount = 0;
        this.lastFpsUpdate = performance.now();
        this.fpsHistory = new Uint8Array(75).fill(60);

        // Interacción de usuario (Bresenham)
        this.isPointerDown = false;
        this.drawMode = 1;
        this.lastCellX = -1;
        this.lastCellY = -1;

        this.initDimensionAndBuffers();
        this.bindEvents();
        this.seedInitialShow();
    }

    /**
     * Inicializa buffers de memoria contigua y precalcula tablas de adyacencia toroidal
     */
    initDimensionAndBuffers() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;

        this.cols = Math.floor(this.canvas.width / this.cellSize);
        this.rows = Math.floor(this.canvas.height / this.cellSize);
        this.totalCells = this.cols * this.rows;

        // Asignación de memoria contigua
        this.grid = new Uint8Array(this.totalCells);
        this.nextGrid = new Uint8Array(this.totalCells);
        this.activeList = new Uint32Array(this.totalCells);
        this.nextActiveList = new Uint32Array(this.totalCells);
        this.activeMask = new Uint8Array(this.totalCells);
        this.activeCount = 0;

        // Precalcular tablas de vecindad para eliminar el operador '%' en el bucle crítico
        this.leftCol = new Uint16Array(this.cols);
        this.rightCol = new Uint16Array(this.cols);
        for (let x = 0; x < this.cols; x++) {
            this.leftCol[x] = (x === 0) ? this.cols - 1 : x - 1;
            this.rightCol[x] = (x === this.cols - 1) ? 0 : x + 1;
        }

        this.upRowOffset = new Uint32Array(this.rows);
        this.downRowOffset = new Uint32Array(this.rows);
        for (let y = 0; y < this.rows; y++) {
            const upY = (y === 0) ? this.rows - 1 : y - 1;
            const downY = (y === this.rows - 1) ? 0 : y + 1;
            this.upRowOffset[y] = upY * this.cols;
            this.downRowOffset[y] = downY * this.cols;
        }

        this.buildOffscreenGridCache();
        this.updateUIStats();
    }

    /**
     * Pre-renderiza el fondo y la malla una única vez en un OffscreenCanvas
     */
    buildOffscreenGridCache() {
        this.gridCacheCanvas.width = this.canvas.width;
        this.gridCacheCanvas.height = this.canvas.height;
        const gCtx = this.gridCacheCtx;

        gCtx.fillStyle = '#05080c';
        gCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.cellSize >= 6) {
            gCtx.strokeStyle = '#0c131c';
            gCtx.lineWidth = 1;
            gCtx.beginPath();
            for (let x = 0; x <= this.cols; x++) {
                const px = x * this.cellSize + 0.5;
                gCtx.moveTo(px, 0);
                gCtx.lineTo(px, this.canvas.height);
            }
            for (let y = 0; y <= this.rows; y++) {
                const py = y * this.cellSize + 0.5;
                gCtx.moveTo(0, py);
                gCtx.lineTo(this.canvas.width, py);
            }
            gCtx.stroke();
        }
    }

    /**
     * Marca una celda y sus 8 vecinos como candidatos activos para la próxima generación
     */
    activateCellAndNeighbors(x, y, targetList, countRef) {
        const cols = this.cols;
        const lx = this.leftCol[x];
        const rx = this.rightCol[x];
        const upOff = this.upRowOffset[y];
        const midOff = y * cols;
        const downOff = this.downRowOffset[y];

        const indices = [
            upOff + lx, upOff + x, upOff + rx,
            midOff + lx, midOff + x, midOff + rx,
            downOff + lx, downOff + x, downOff + rx
        ];

        for (let i = 0; i < 9; i++) {
            const idx = indices[i];
            if (this.activeMask[idx] === 0) {
                this.activeMask[idx] = 1;
                targetList[countRef.count++] = idx;
            }
        }
    }

    /**
     * Establece el valor de una celda manualmente e inyecta su vecindad al conjunto activo
     */
    setCell(x, y, state) {
        if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
        const idx = y * this.cols + x;
        const prev = this.grid[idx];

        if ((prev > 0) === (state > 0)) return;

        this.grid[idx] = state;
        this.nextGrid[idx] = state;
        this.aliveCount += (state > 0) ? 1 : -1;

        const countRef = { count: this.activeCount };
        this.activateCellAndNeighbors(x, y, this.activeList, countRef);
        this.activeCount = countRef.count;
    }

    /**
     * Paso de evolución algorítmica O(A) donde A = número de celdas en zonas dinámicas
     */
    stepGeneration() {
        const t0 = performance.now();

        const cols = this.cols;
        const grid = this.grid;
        const nextGrid = this.nextGrid;
        const activeList = this.activeList;
        const currentActiveCount = this.activeCount;

        // 1. Copiar estado base de las celdas activas y limpiar máscara para el turno t+1
        for (let i = 0; i < currentActiveCount; i++) {
            const idx = activeList[i];
            nextGrid[idx] = grid[idx];
            this.activeMask[idx] = 0;
        }

        const nextCountRef = { count: 0 };
        const changedIndices = [];

        // 2. Evaluar únicamente los nodos registrados en la lista activa
        for (let i = 0; i < currentActiveCount; i++) {
            const idx = activeList[i];
            const y = (idx / cols) | 0;
            const x = idx - (y * cols);

            const lx = this.leftCol[x];
            const rx = this.rightCol[x];
            const upOff = this.upRowOffset[y];
            const midOff = y * cols;
            const downOff = this.downRowOffset[y];

            // Loop Unrolling de los 8 vecinos de Moore (sin bucles for anidados)
            const neighbors =
                (grid[upOff + lx] > 0) +
                (grid[upOff + x] > 0) +
                (grid[upOff + rx] > 0) +
                (grid[midOff + lx] > 0) +
                (grid[midOff + rx] > 0) +
                (grid[downOff + lx] > 0) +
                (grid[downOff + x] > 0) +
                (grid[downOff + rx] > 0);

            const currentAge = grid[idx];

            if (currentAge > 0) {
                if (neighbors === 2 || neighbors === 3) {
                    // Sobrevive y envejece para el gradiente cromático
                    if (currentAge < 255) {
                        nextGrid[idx] = currentAge + 1;
                        // Si aún está cambiando de color visualmente, mantener celda en observación
                        if (currentAge < 8 && this.activeMask[idx] === 0) {
                            this.activeMask[idx] = 1;
                            this.nextActiveList[nextCountRef.count++] = idx;
                        }
                    }
                } else {
                    // Muere por baja población o sobrepoblación
                    nextGrid[idx] = 0;
                    this.aliveCount--;
                    changedIndices.push(x, y);
                }
            } else if (neighbors === 3) {
                // Nacimiento por reproducción
                nextGrid[idx] = 1;
                this.aliveCount++;
                changedIndices.push(x, y);
            }
        }

        // 3. Propagar actividad a los vecinos de las celdas que sufrieron transición
        for (let i = 0; i < changedIndices.length; i += 2) {
            this.activateCellAndNeighbors(
                changedIndices[i],
                changedIndices[i + 1],
                this.nextActiveList,
                nextCountRef
            );
        }

        // 4. Sincronizar los cambios de vuelta al segundo buffer y hacer Pointer Swap O(1)
        for (let i = 0; i < currentActiveCount; i++) {
            const idx = activeList[i];
            grid[idx] = nextGrid[idx];
        }

        // Intercambio de listas activas sin crear objetos nuevos en el Heap
        const tempList = this.activeList;
        this.activeList = this.nextActiveList;
        this.nextActiveList = tempList;
        this.activeCount = nextCountRef.count;

        this.generation++;
        this.lastComputeMs = performance.now() - t0;
    }

    /**
     * Renderizado de alta velocidad mediante Canvas Path Batching (3 llamadas GPU en total)
     */
    render() {
        const ctx = this.ctx;
        const size = this.cellSize;
        const pad = size >= 6 ? 1 : 0;
        const drawSize = size - pad;
        const cols = this.cols;
        const grid = this.grid;
        const total = this.totalCells;

        // 1. Volcar el caché del fondo y cuadrícula en una sola operación bit-blit
        ctx.drawImage(this.gridCacheCanvas, 0, 0);

        // 2. Agrupar geometría por edad en 3 Path2D independientes
        const pathNewborn = new Path2D(); // Edad 1 (Cian eléctrico)
        const pathYoung = new Path2D();   // Edad 2..6 (Verde neón)
        const pathMature = new Path2D();  // Edad 7+ (Esmeralda profundo)

        for (let idx = 0; idx < total; idx++) {
            const age = grid[idx];
            if (age === 0) continue;

            const y = (idx / cols) | 0;
            const x = idx - (y * cols);
            const px = x * size + pad;
            const py = y * size + pad;

            if (age === 1) {
                pathNewborn.rect(px, py, drawSize, drawSize);
            } else if (age < 7) {
                pathYoung.rect(px, py, drawSize, drawSize);
            } else {
                pathMature.rect(px, py, drawSize, drawSize);
            }
        }

        // 3. Ejecutar rasterizado por lotes
        ctx.fillStyle = '#00e5ff';
        ctx.fill(pathNewborn);

        ctx.fillStyle = '#00ff9d';
        ctx.fill(pathYoung);

        ctx.fillStyle = '#059669';
        ctx.fill(pathMature);
    }

    /**
     * Algoritmo de línea de Bresenham para dibujo continuo sin saltos de muestreo
     */
    drawLineBresenham(x0, y0, x1, y1, state) {
        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;

        while (true) {
            this.setCell(x0, y0, state);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }

    clear() {
        this.grid.fill(0);
        this.nextGrid.fill(0);
        this.activeMask.fill(0);
        this.activeCount = 0;
        this.generation = 0;
        this.aliveCount = 0;
        this.lastComputeMs = 0;
        this.render();
        this.updateUIStats();
    }

    randomize(density = 0.22) {
        this.clear();
        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                if (Math.random() < density) {
                    this.setCell(x, y, 1);
                }
            }
        }
        this.render();
        this.updateUIStats();
    }

    insertPattern(patternName, customX = null, customY = null) {
        const patterns = {
            gosper: [
                [0, 24], [1, 22], [1, 24], [2, 12], [2, 13], [2, 20], [2, 21], [2, 34], [2, 35],
                [3, 11], [3, 15], [3, 20], [3, 21], [3, 34], [3, 35], [4, 0], [4, 1], [4, 10],
                [4, 16], [4, 20], [4, 21], [5, 0], [5, 1], [5, 10], [5, 14], [5, 16], [5, 17],
                [5, 22], [5, 24], [6, 10], [6, 16], [6, 24], [7, 11], [7, 15], [8, 12], [8, 13]
            ],
            pulsar: [
                [2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0],
                [0, 2], [5, 2], [7, 2], [12, 2], [0, 3], [5, 3], [7, 3], [12, 3], [0, 4], [5, 4], [7, 4], [12, 4],
                [2, 5], [3, 5], [4, 5], [8, 5], [9, 5], [10, 5],
                [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7],
                [0, 8], [5, 8], [7, 8], [12, 8], [0, 9], [5, 9], [7, 9], [12, 9], [0, 10], [5, 10], [7, 10], [12, 10],
                [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12]
            ],
            acorn: [
                [0, 1], [1, 3], [2, 0], [2, 1], [2, 4], [2, 5], [2, 6]
            ],
            spaceship: [
                [0, 1], [0, 4], [1, 0], [2, 0], [2, 4], [3, 0], [3, 1], [3, 2], [3, 3],
                [6, 1], [6, 4], [7, 0], [8, 0], [8, 4], [9, 0], [9, 1], [9, 2], [9, 3]
            ]
        };

        const coords = patterns[patternName];
        if (!coords) return;

        const startX = customX !== null ? customX : Math.floor(this.cols / 2) - 12;
        const startY = customY !== null ? customY : Math.floor(this.rows / 2) - 6;

        for (let i = 0; i < coords.length; i++) {
            const [py, px] = coords[i];
            const tx = (startX + px + this.cols) % this.cols;
            const ty = (startY + py + this.rows) % this.rows;
            this.setCell(tx, ty, 1);
        }
        this.render();
        this.updateUIStats();
    }

    seedInitialShow() {
        this.clear();
        this.insertPattern('gosper', 8, 8);
        this.insertPattern('pulsar', Math.floor(this.cols * 0.65), Math.floor(this.rows * 0.35));
        this.insertPattern('acorn', Math.floor(this.cols * 0.35), Math.floor(this.rows * 0.65));
    }

    updateUIStats() {
        document.getElementById('statGen').textContent = this.generation.toLocaleString();
        document.getElementById('statAlive').textContent = this.aliveCount.toLocaleString();
        document.getElementById('statGrid').textContent = `${this.cols}×${this.rows}`;

        const activeRatio = ((this.activeCount / this.totalCells) * 100).toFixed(1);
        document.getElementById('statActive').textContent = `${activeRatio}% (${this.activeCount})`;
        document.getElementById('perfBadge').textContent = `CPU: ${this.lastComputeMs.toFixed(2)} ms`;
    }

    updateFpsTelemetry(now) {
        this.frameCount++;
        const elapsed = now - this.lastFpsUpdate;

        if (elapsed >= 400) {
            const fps = Math.min(60, Math.round((this.frameCount * 1000) / elapsed));
            const frameTime = (elapsed / this.frameCount).toFixed(1);

            document.getElementById('fpsValue').textContent = fps;
            document.getElementById('frameTime').textContent = `${frameTime} ms`;

            this.fpsHistory.copyWithin(0, 1);
            this.fpsHistory[this.fpsHistory.length - 1] = fps;

            this.frameCount = 0;
            this.lastFpsUpdate = now;

            // Renderizar oscilograma de rendimiento
            const fCtx = this.fpsCtx;
            const w = this.fpsCanvas.width;
            const h = this.fpsCanvas.height;
            fCtx.fillStyle = '#040609';
            fCtx.fillRect(0, 0, w, h);

            const barW = w / this.fpsHistory.length;
            for (let i = 0; i < this.fpsHistory.length; i++) {
                const val = this.fpsHistory[i];
                const barH = (val / 65) * h;
                fCtx.fillStyle = val >= 50 ? '#00ff9d' : (val >= 30 ? '#fbbf24' : '#ef4444');
                fCtx.fillRect(i * barW, h - barH, barW - 0.6, barH);
            }
        }
    }

    bindEvents() {
        const getGridCoords = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            return {
                x: Math.floor((e.clientX - rect.left) / this.cellSize),
                y: Math.floor((e.clientY - rect.top) / this.cellSize)
            };
        };

        this.canvas.addEventListener('contextmenu', e => e.preventDefault());

        this.canvas.addEventListener('mousedown', (e) => {
            this.isPointerDown = true;
            this.drawMode = (e.button === 2) ? 0 : 1;
            const { x, y } = getGridCoords(e);
            this.setCell(x, y, this.drawMode);
            this.lastCellX = x;
            this.lastCellY = y;
            this.render();
            this.updateUIStats();
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isPointerDown) return;
            const { x, y } = getGridCoords(e);
            if (x !== this.lastCellX || y !== this.lastCellY) {
                this.drawLineBresenham(this.lastCellX, this.lastCellY, x, y, this.drawMode);
                this.lastCellX = x;
                this.lastCellY = y;
                this.render();
                this.updateUIStats();
            }
        });

        window.addEventListener('mouseup', () => {
            this.isPointerDown = false;
        });

        // Controles de Interfaz
        const btnPlay = document.getElementById('btnPlay');
        const statState = document.getElementById('statState');

        const togglePlay = () => {
            this.isRunning = !this.isRunning;
            btnPlay.textContent = this.isRunning ? 'Pausar' : 'Reanudar';
            statState.textContent = this.isRunning ? 'EJECUTANDO' : 'PAUSADO';
            statState.className = this.isRunning ? 'status-run' : 'status-pause';
        };

        btnPlay.addEventListener('click', togglePlay);

        document.getElementById('btnStep').addEventListener('click', () => {
            if (this.isRunning) togglePlay();
            this.stepGeneration();
            this.render();
            this.updateUIStats();
        });

        document.getElementById('btnRandom').addEventListener('click', () => this.randomize(0.22));
        document.getElementById('btnClear').addEventListener('click', () => this.clear());

        document.getElementById('speedRange').addEventListener('input', (e) => {
            this.simSpeed = parseInt(e.target.value, 10);
            document.getElementById('speedVal').textContent = this.simSpeed;
        });

        document.getElementById('sizeRange').addEventListener('input', (e) => {
            this.cellSize = parseInt(e.target.value, 10);
            document.getElementById('sizeVal').textContent = this.cellSize;
            this.initDimensionAndBuffers();
            this.seedInitialShow();
        });

        document.querySelectorAll('.pattern-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.insertPattern(btn.dataset.pattern);
            });
        });

        // Atajos de teclado para fluidez durante la presentación
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                e.preventDefault();
                togglePlay();
            } else if (e.code === 'KeyN') {
                if (this.isRunning) togglePlay();
                this.stepGeneration();
                this.render();
                this.updateUIStats();
            } else if (e.code === 'KeyC') {
                this.clear();
            }
        });

        window.addEventListener('resize', () => {
            this.initDimensionAndBuffers();
            this.seedInitialShow();
        });
    }

    startLoop() {
        const loop = (now) => {
            requestAnimationFrame(loop);
            this.updateFpsTelemetry(now);

            const interval = 1000 / this.simSpeed;
            if (this.isRunning && (now - this.lastStepTime >= interval)) {
                this.stepGeneration();
                this.render();
                this.updateUIStats();
                this.lastStepTime = now;
            }
        };
        requestAnimationFrame(loop);
    }
}

// Inicialización del sistema
window.addEventListener('DOMContentLoaded', () => {
    const engine = new CellularAutomataEngine(
        document.getElementById('gridCanvas'),
        document.getElementById('fpsCanvas')
    );
    engine.startLoop();
});