// localStorage Polyfill for headless and privacy environments
(function() {
  try {
    const test = window.localStorage;
    if (!test) throw new Error("localStorage is null");
    test.setItem('__test_ls_key__', '1');
    test.removeItem('__test_ls_key__');
  } catch (e) {
    console.warn("localStorage is blocked or unsupported, utilizing memory fallback.", e);
    const store = {};
    const mockStorage = {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = String(val); },
      removeItem: (key) => { delete store[key]; },
      clear: () => { for (const k in store) delete store[k]; }
    };
    try {
      Object.defineProperty(window, 'localStorage', {
        value: mockStorage,
        writable: true,
        configurable: true
      });
    } catch(err) {
      window.localStorage = mockStorage;
    }
  }
})();
// game.js - スマートフォン縦型パズルゲームロジック（スワイプ・タップ・Canvasパーティクル・PCキーボード両対応）

// 【計測用】Android実機でのGPU負荷比較測定のためのフラグ。
// true  : 広告サンプルのアニメーション（sp-shimmer / sp-pulse）を再生する（通常時のデフォルト）
// false : レイアウト・サイズは変えず、広告サンプルのアニメーションだけ停止する
const DEBUG_AD_ANIMATION = false; // ← 検証用ビルド：広告サンプルを完全静止させて比較測定するためfalseに設定

// 【デバッグ表示切替】盤面右上のデバッグ用ステータス（FPS/CPU/GPU/CELLS/SIZE/PHYSなど）の表示切替。
// true  : デバッグステータスを表示する
// false : 表示しない（通常プレイ時のデフォルト）
const DEBUG_STATS = false;

const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 }
];

const Stats = {
  storageKey: 'imode_puzzle_stats',
  
  getStorageKey() {
    let targetMode = (typeof Game !== 'undefined') ? Game.gameMode : 'NORMAL';
    if (typeof Game !== 'undefined' && Game.state === 'STATS_VIEW') {
      targetMode = Game.viewingStatsMode === 'GRAVITY' ? 'GRAVITY' : (Game.viewingStatsMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'CLASSIC');
    }
    const mode = (targetMode === 'GRAVITY') ? 'gravity' : (targetMode === 'MIDNIGHT' ? 'midnight' : 'classic');
    if (mode === 'gravity') return 'imode_puzzle_stats_gravity';
    if (mode === 'midnight') return 'imode_puzzle_stats_midnight';
    return 'imode_puzzle_stats';
  },

  get() {
    const data = localStorage.getItem(this.getStorageKey());
    if (!data) {
      return { gamesPlayed: 0, totalBlocksCleared: 0, maxBlocksSingleClear: 0, maxCombo: 0 };
    }
    try {
      return JSON.parse(data);
    } catch (e) {
      return { gamesPlayed: 0, totalBlocksCleared: 0, maxBlocksSingleClear: 0, maxCombo: 0 };
    }
  },
  
  save(stats) {
    localStorage.setItem(this.getStorageKey(), JSON.stringify(stats));
  },
  
  incrementGamesPlayed() {
    const s = this.get();
    s.gamesPlayed += 1;
    this.save(s);
  },
  
  addBlocksCleared(count) {
    const s = this.get();
    s.totalBlocksCleared += count;
    if (count > s.maxBlocksSingleClear) {
      s.maxBlocksSingleClear = count;
    }
    this.save(s);
  },
  
  updateMaxCombo(combo) {
    const s = this.get();
    if (combo > s.maxCombo) {
      s.maxCombo = combo;
    }
    this.save(s);
  }
};

const Game = {
  width: 16,
  height: 20,
  board: [], // board[y][x] = { color: 1~5, locked: false, el: HTMLElement } or null
  cursor: { x: 0, y: 0 },
  activeGroup: null, // { color, blocks: [{x, y}, ...], locked: false }
  
  score: 0,
  combo: 0,
  bestScore: 0,
  
  isAnimating: false,
  inputMode: 'MOUSE', // KEYBOARD or MOUSE
  state: 'TITLE', // TITLE, HELP_VIEW, SETTINGS, STATS_VIEW, PLAYING, GAME_OVER, RANKING_VIEW, DIALOG
  menuIndex: 0,
  isGameCleared: false,
  rankingMode: 'ALL',
  viewingRankMode: 'CLASSIC', // CLASSIC or GRAVITY (ranking display mode)
  viewingHelpMode: 'CLASSIC', // CLASSIC or GRAVITY (help display mode)
  viewingStatsMode: 'CLASSIC', // CLASSIC, GRAVITY or MIDNIGHT (stats display mode)
  settingsTemp: {
    sound: true,
    background: 'city',
    width: 16,
    height: 20
  },
  
  playerName: 'プレイヤー',
  newRank: 0,
  backgroundType: 'city',
  
  // モード・重力用変数
  gameMode: 'NORMAL', // 'NORMAL' or 'GRAVITY'
  nextGravityDirection: null, // {dx, dy, label, icon} 次ターン開始時に適用される重力方向
  gravityDirections: [
    { dx: 0, dy: -1, label: 'UP', icon: '⬆️ UP' },
    { dx: 0, dy: 1, label: 'DOWN', icon: '⬇️ DOWN' },
    { dx: -1, dy: 0, label: 'LEFT', icon: '⬅️ LEFT' },
    { dx: 1, dy: 0, label: 'RIGHT', icon: '➡️ RIGHT' }
  ],

  dialogCallback: null,
  dialogChoices: [],
  dialogMenuIndex: 0,
  previousState: '',

  // スキル用変数
  skills: {
    undo: { count: 1, max: 1 },
    move: { count: 1, max: 1 },
    change: { count: 1, max: 1 }
  },
  undoHistory: null, // 一手戻すための直前盤面データキャッシュ
  skillActiveMode: null, // null, 'MOVE', 'CHANGE' (スキル発動中の操作選択モード)
  skillSelectedGroup: null, // 'MOVE', 'CHANGE' 対象として選んだブロック塊の情報
  changeTargetColor: null, // CHANGEスキルで変化させる選択カラー値

  cursorEl: null,
  
  colors: {
    1: { name: '赤', class: 'block-red', hex: '#ff7675' },
    2: { name: '青', class: 'block-blue', hex: '#74b9ff' },
    3: { name: '緑', class: 'block-green', hex: '#55efc4' },
    4: { name: '黄', class: 'block-yellow', hex: '#ffeaa7' },
    5: { name: '紫', class: 'block-purple', hex: '#a29bfe' }
  },

  // ドラッグ/スワイプ一時データ
  dragStart: { x: 0, y: 0, time: 0 },
  dragActive: false,
  draggedGrid: null,

  // Canvasエフェクト関連データ (パフォーマンス改善用)
  canvas: null,
  ctx: null,
  particles: [],
  popups: [],
  isLoopingEffects: false,
  _lastEffectsFrameTime: null, // 【最適化】loopEffectsを60FPSに制限するための基準時刻

  // 盤面Canvas描画・キャッシュデータ
  boardCanvas: null,
  boardCtx: null,
  staticLayerCanvas: null, // 【最適化】アニメーション/ドラッグ中の静止セルをキャッシュするオフスクリーンcanvas
  staticLayerCtx: null,
  _staticCacheAnim: null, // アニメーションのanim参照、またはドラッグセッションIDをキーとして保持
  _staticCacheDynamicCells: null,
  _dragSessionId: 0, // MOVEスキルドラッグ中の静止レイヤーキャッシュ識別用
  gradientCache: {},
  pathCache: {},
  cellTileCache: {}, // 【最適化】GPU負荷の高いclip()呼び出しを削減するための静止セル描画タイルキャッシュ
  lockPattern: null,
  currentAnimations: null,
  isLoopingBoard: false,
  boardAnimationId: null,
  _lastBoardFrameTime: null, // 【最適化】loopBoardを60FPSに制限するための基準時刻
  lastFpsTime: null,
  fpsCount: 0,
  fps: 60,
  dragOffset: null,
  animatingCoords: null,
  highlightGradient: null,

  applyBackground(bgType) {
    document.body.classList.remove('bg-style-normal', 'bg-style-city');
    if (bgType === 'city') {
      document.body.classList.add('bg-style-city');
    } else {
      document.body.classList.add('bg-style-normal');
    }
  },

  init() {
    this.playerName = localStorage.getItem('imode_puzzle_player_name') || 'プレイヤー';
    const nameInput = document.getElementById('player-name-input');
    if (nameInput) nameInput.value = this.playerName;

    // 広告の初期設定が未登録の場合はデフォルトで表示（false）にする
    if (localStorage.getItem('block_slider_remove_ads') === null) {
      localStorage.setItem('block_slider_remove_ads', 'false');
    }

    this.width = 16;
    this.height = 22;

    const myBest = Ranking.getMyBest();
    this.bestScore = myBest ? myBest.score : 0;
    Sound.initBgm();
    this.soundEnabled = Sound.enabled;
    this.bgmEnabled = Sound.bgmEnabled;
    this.backgroundType = localStorage.getItem('imode_puzzle_background') || 'city';
    this.settingsTemp = {
      bgm: Sound.bgmEnabled,
      sound: Sound.enabled,
      background: this.backgroundType
    };
    this.applyBackground(this.backgroundType);
    
    // Canvasの初期取得
    this.canvas = document.getElementById('effect-canvas');
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
    }
    this.boardCanvas = document.getElementById('board-canvas');
    if (this.boardCanvas) {
      this.boardCtx = this.boardCanvas.getContext('2d');
    }
    this.animatingCoords = new Set();

    this.setupEventListeners();
    this.generateBoard();
    this.render();

    // タイトル画面表示時からBGMの再生をリクエスト
    Sound.playBgm();

    window.addEventListener('resize', () => {
      this.adjustBoardSize();
      this.adjustCanvasSize();
    });
  },

  showDialog(message, choices, callback, isColorSelect = false, sourceColor = null) {
    this.dialogCallback = callback;
    this.dialogChoices = choices;
    this.dialogMenuIndex = 0;
    this.previousState = this.state;
    this.state = 'DIALOG';
    this.isColorSelect = isColorSelect;
    this.dialogSourceColor = sourceColor; // 元のグループ色コードをキャッシュ

    const overlay = document.getElementById('dialog-overlay');
    const msgEl = document.getElementById('dialog-message');
    if (msgEl) msgEl.innerText = message;
    
    // 画面外タッチ（overlay自体のタップ）でキャンセルするイベントをバインド
    if (overlay) {
      overlay.onclick = (e) => {
        if (e.target === overlay) {
          e.stopPropagation();
          Sound.playCancel();
          const callback = this.dialogCallback;
          this.closeDialog();
          if (callback) callback(-1); // 画面外タッチは -1 を返す
        }
      };
    }
    
    this.renderDialogChoices();
    if (overlay) overlay.style.display = 'flex';
  },

  renderDialogChoices() {
    const choicesEl = document.getElementById('dialog-choices');
    if (!choicesEl) return;
    choicesEl.innerHTML = '';

    if (this.isColorSelect) {
      choicesEl.className = 'color-choice-container';
      choicesEl.style.display = 'grid';
      choicesEl.style.gridTemplateColumns = 'repeat(4, 1fr)'; // 4色なので4列グリッドに変更
      choicesEl.style.gap = '8px';
      choicesEl.style.width = '100%';

      const colorData = [
        { id: 1, class: 'c-red' },
        { id: 2, class: 'c-blue' },
        { id: 3, class: 'c-green' },
        { id: 4, class: 'c-yellow' },
        { id: 5, class: 'c-purple' }
      ];

      // 元の色 (this.dialogSourceColor) を除外した4つだけのボタンを生成
      const activeChoices = colorData.filter(c => c.id !== this.dialogSourceColor);

      activeChoices.forEach((colorItem, idx) => {
        const el = document.createElement('div');
        el.className = `color-choice-btn ${colorItem.class}`;
        if (idx === this.dialogMenuIndex) {
          el.classList.add('active-choice');
        }
        
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          Sound.playSelect();
          const callback = this.dialogCallback;
          this.closeDialog();
          if (callback) callback(idx);
        });
        choicesEl.appendChild(el);
      });

      const cancelEl = document.createElement('div');
      cancelEl.className = 'menu-item';
      cancelEl.style.gridColumn = 'span 4'; // 4列スパン
      cancelEl.style.justifyContent = 'center';
      cancelEl.innerText = 'キャンセル';
      if (this.dialogMenuIndex === 4) { // 選択肢インデックス4がキャンセル
        cancelEl.classList.add('active');
      }
      cancelEl.addEventListener('click', (e) => {
        e.stopPropagation();
        Sound.playCancel();
        const callback = this.dialogCallback;
        this.closeDialog();
        if (callback) callback(4);
      });
      choicesEl.appendChild(cancelEl);
    } else {
      choicesEl.className = 'menu-list';
      // インラインスタイルをリセットし、縦一列のflexレイアウトを維持する
      choicesEl.style.display = '';
      choicesEl.style.gridTemplateColumns = '';
      choicesEl.style.gap = '';
      choicesEl.style.width = '';
      
      this.dialogChoices.forEach((choice, idx) => {
        const el = document.createElement('div');
        el.className = 'menu-item';
        if (idx === this.dialogMenuIndex) {
          el.classList.add('active');
        }
        el.innerText = choice;
        
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          Sound.playSelect();
          const callback = this.dialogCallback;
          this.closeDialog();
          if (callback) callback(idx);
        });

        choicesEl.appendChild(el);
      });
    }
  },

  closeDialog() {
    const overlay = document.getElementById('dialog-overlay');
    if (overlay) overlay.style.display = 'none';
    this.isColorSelect = false;
    this.state = this.previousState;
  },

  startNewGame() {
    this.showDialog(
      "SELECT MODE",
      ["Standard", "Gravity", "Midnight"],
      (choice) => {
        if (choice === -1) {
          this.backToTitle(true);
          return;
        }
        let selectedMode = 'NORMAL';
        if (choice === 1) selectedMode = 'GRAVITY';
        else if (choice === 2) selectedMode = 'MIDNIGHT';
        
        const container = document.getElementById('game-container');
        if (!container) {
          this.executeStartNewGame(selectedMode);
          return;
        }

        // 1. シャッター演出の決定 (閉じる・開くで同じパターンを使用)
        const patterns = [
          'door-pattern-horizontal',
          'door-pattern-vertical',
          'door-pattern-four-way',
          'door-pattern-single-vertical',
          'door-pattern-sweep',
          'door-pattern-portal'
        ];
        
        const rand = Math.random();
        let selectedPattern = 'door-pattern-horizontal';
        if (rand < 0.30) selectedPattern = 'door-pattern-vertical';        // 上下に開閉 (30%)
        else if (rand < 0.60) selectedPattern = 'door-pattern-horizontal';  // 左右に開閉 (30%)
        else if (rand < 0.80) selectedPattern = 'door-pattern-four-way';    // 四方から開閉 (20%)
        else if (rand < 0.90) selectedPattern = 'door-pattern-single-vertical'; // 1枚上下開閉 (10%)
        else if (rand < 0.99) selectedPattern = 'door-pattern-sweep';       // 通り過ぎる (9%)
        else selectedPattern = 'door-pattern-portal';                       // 異次元ポータル (1%)

        // 既存パターンを全て削除して付与
        patterns.forEach(p => container.classList.remove(p));
        container.classList.add(selectedPattern);

        // 「通り過ぎる」パターンの場合は、閉じる前にドア要素を左端（translateX(-100%)）に一瞬で隠す
        const doorLeft = document.getElementById('transition-door-left');
        if (selectedPattern === 'door-pattern-sweep' && doorLeft) {
          doorLeft.style.transition = 'none';
          doorLeft.style.transform = 'translateX(-100%)';
          void doorLeft.offsetWidth; // リフロー強制
          doorLeft.style.transition = ''; // トランジションを戻す
        }

        // シャッターを閉じる
        container.classList.add('door-closed');

        // 閉じるのに0.6秒。閉まりきったタイミングで状態をリセットし、裏で切り替える
        setTimeout(() => {
          this.executeStartNewGame(selectedMode);

          // 切り替え後、少しだけディレイを置いてシャッターを開ける
          setTimeout(() => {
            container.classList.remove('door-closed');

            // シャッターが完全に開ききる時間（600ms）を待ってから、デカ文字STARTポップアップを表示
            setTimeout(() => {
              this.triggerStartPopup();
            }, 600);
          }, 100);
        }, 600);
      }
    );
  },

  executeStartNewGame(selectedMode = 'NORMAL') {
    Sound.playBgm();
    this.score = 0;
    this.combo = 0;
    this.activeGroup = null;
    this.isAnimating = true;
    this.isGameCleared = false;
    this.gameMode = selectedMode;

    if (this.gameMode === 'GRAVITY') {
      const randIdx = Math.floor(Math.random() * this.gravityDirections.length);
      this.nextGravityDirection = this.gravityDirections[randIdx];
    } else {
      this.nextGravityDirection = null;
    }

    // スキル状態の初期化
    this.skills = {
      undo: { count: 1, max: 1 },
      move: { count: 1, max: 1 },
      change: { count: 1, max: 1 }
    };
    this.undoHistory = null;
    this.skillActiveMode = null;
    this.skillSelectedGroup = null;
    this.changeTargetColor = null;
    
    // エフェクトのクリア
    this.particles = [];
    this.popups = [];
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // 盤面生成 (モード確定後に再作成させることで整合性を維持)
    this.generateBoard();
    if (this.gameMode === 'MIDNIGHT') {
      // ミッドナイトモード時は裏で強制リロールを発生させる
      this.generateBoard();
    }

    Stats.incrementGamesPlayed();
    this.cursor = { x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) };
    this.state = 'PLAYING';
    const myBest = Ranking.getMyBest();
    this.bestScore = myBest ? myBest.score : 0;
    
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const boardEl = document.getElementById('board');
    if (boardEl) {
      if (this.gameMode === 'MIDNIGHT') {
        boardEl.classList.add('board-midnight-bg');
      } else {
        boardEl.classList.remove('board-midnight-bg');
      }
    }

    window.focus();
    this.render();
  },

  // ゲーム開始時の「START」文字ポップアップアニメーション演出
  triggerStartPopup() {
    const popup = document.getElementById('game-start-popup');
    if (!popup) {
      this.isAnimating = false; // ポップアップ要素がない場合は即座に操作可能にする
      return;
    }

    // 演出中は操作ブロック（isAnimating=true）を維持
    this.isAnimating = true;
    popup.style.display = 'flex';
    popup.classList.add('animate-start');

    // 1.2秒後（アニメーション終了後）に非表示にし、プレイヤー操作を許可する
    setTimeout(() => {
      popup.classList.remove('animate-start');
      popup.style.display = 'none';
      this.isAnimating = false; // ここで初めて操作可能に！
    }, 1200);
  },

  backToTitle(reroll = true) {
    const boardEl = document.getElementById('board');
    if (boardEl) {
      boardEl.classList.remove('board-midnight-bg');
    }

    // タイトルの背景盤面は常にカラフルなスタンダードモード（NORMAL）にする
    this.gameMode = 'NORMAL';

    if (reroll) {
      this.generateBoard();
      this.cursor = { x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) };
    }
    this.state = 'TITLE';
    this.menuIndex = 0;

    // タイトル背景用の盤面をDOMに反映
    this.updateBoardState();
    this.updateBlockConnections();

    this.render();
  },

  saveSuspendedGame() {
    const data = {
      score: this.score,
      combo: this.combo,
      gameMode: this.gameMode,
      nextGravityDirection: this.nextGravityDirection,
      board: this.board.map(row => row.map(cell => {
        if (!cell) return null;
        return {
          color: cell.color,
          locked: cell.locked,
          revealed: cell.revealed,
          revealCount: cell.revealCount
        };
      })),
      skills: this.skills,
      undoHistory: this.undoHistory ? {
        actionType: this.undoHistory.actionType,
        actionData: this.undoHistory.actionData,
        score: this.undoHistory.score,
        combo: this.undoHistory.combo,
        board: this.undoHistory.board,
        gameMode: this.undoHistory.gameMode,
        nextGravityDirection: this.undoHistory.nextGravityDirection
      } : null
    };
    localStorage.setItem('block_slider_suspended_game', JSON.stringify(data));
  },

  clearSuspendedGame() {
    localStorage.removeItem('block_slider_suspended_game');
  },

  hasSuspendedGame() {
    return localStorage.getItem('block_slider_suspended_game') !== null;
  },

  resumeSuspendedGame() {
    Sound.playBgm();
    const raw = localStorage.getItem('block_slider_suspended_game');
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      this.score = data.score;
      this.combo = data.combo;
      this.gameMode = data.gameMode || 'NORMAL';
      this.nextGravityDirection = data.nextGravityDirection || null;
      this.skills = data.skills;
      this.undoHistory = data.undoHistory;
      
      // Board DOM を再構築
      this.board = data.board.map(row => row.map(cell => {
        if (!cell) return null;
        return {
          color: cell.color,
          locked: cell.locked,
          revealed: cell.revealed || false,
          revealCount: cell.revealCount || 0,
          el: null
        };
      }));

      // エフェクトのクリア
      this.particles = [];
      this.popups = [];
      if (this.ctx && this.canvas) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }

      this.updateBoardState();
      
      this.cursor = { x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) };
      this.state = 'PLAYING';
      this.activeGroup = null;
      this.skillActiveMode = null;
      this.skillSelectedGroup = null;

      const myBest = Ranking.getMyBest();
      this.bestScore = myBest ? myBest.score : 0;
      
      this.clearSuspendedGame(); // 再開したらセーブデータを消去

      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      window.focus();
      this.render();
      Sound.playSelect();
    } catch (e) {
      console.error("Resume failed", e);
      this.clearSuspendedGame();
      this.startNewGame();
    }
  },

  adjustBoardSize() {
    const wrapper = document.querySelector('.board-wrapper');
    const boardEl = document.getElementById('board');
    if (!wrapper || !boardEl) return;

    // 枠線の太さとpaddingを考慮した実効利用可能領域を算出
    const style = window.getComputedStyle(wrapper);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const borderBottom = parseFloat(style.borderBottomWidth) || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;

    const wrapperWidth = wrapper.clientWidth - (paddingLeft + paddingRight);
    const wrapperHeight = wrapper.clientHeight - (paddingTop + paddingBottom);

    const targetRatio = this.width / this.height;
    const currentRatio = wrapperWidth / wrapperHeight;

    let boardWidth, boardHeight;
    if (currentRatio > targetRatio) {
      boardHeight = wrapperHeight;
      boardWidth = wrapperHeight * targetRatio;
    } else {
      boardWidth = wrapperWidth;
      boardHeight = wrapperWidth / targetRatio;
    }

    boardEl.style.width = `${boardWidth}px`;
    boardEl.style.height = `${boardHeight}px`;

    this.adjustCanvasSize();
  },

  adjustCanvasSize() {
    // 【最適化】高dpr端末（Android実機で3〜4倍が一般的）でのGPU負荷抑制のため上限2.0を設定
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 1. effect-canvas (パーティクル用)
    if (this.canvas) {
      const container = document.getElementById('game-container');
      if (container) {
        const rect = container.getBoundingClientRect();
        const targetW = Math.floor(rect.width * dpr);
        const targetH = Math.floor(rect.height * dpr);
        if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
          this.canvas.width = targetW;
          this.canvas.height = targetH;
          this.canvas.style.width = `${rect.width}px`;
          this.canvas.style.height = `${rect.height}px`;
          this.canvas.style.left = `0px`;
          this.canvas.style.top = `0px`;
          if (this.ctx) {
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          }
        }
      }
    }

    // 2. board-canvas (盤面用)
    if (this.boardCanvas && this.boardCtx) {
      const boardEl = document.getElementById('board');
      if (boardEl) {
        const boardWidth = boardEl.clientWidth;
        const boardHeight = boardEl.clientHeight;
        const targetW = Math.floor(boardWidth * dpr);
        const targetH = Math.floor(boardHeight * dpr);
        
        if (this.boardCanvas.width !== targetW || this.boardCanvas.height !== targetH) {
          this.boardCanvas.width = targetW;
          this.boardCanvas.height = targetH;
          this.boardCanvas.style.width = `${boardWidth}px`;
          this.boardCanvas.style.height = `${boardHeight}px`;
          
          this.boardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          
          this.rebuildCache(boardWidth, boardHeight);
          this.renderBoard();
        }
      }
    }
  },

  rebuildCache(boardWidth, boardHeight) {
    if (!this.boardCtx) return;
    
    const cellWidth = boardWidth / this.width;
    const cellHeight = boardHeight / this.height;

    // 【最適化】静止セルのタイルキャッシュ（clip()呼び出し削減用）もセルサイズ変更時にクリア
    this.cellTileCache = {};

    // 1. グラデーションキャッシュの作成
    this.gradientCache = {};
    const colorStops = {
      1: ['#ff7171', '#e84545'], // 赤
      2: ['#5198ff', '#1d69d4'], // 青
      3: ['#4edb7b', '#10a83e'], // 緑
      4: ['#ffe17d', '#e5b61a'], // 黄
      5: ['#d3adff', '#8a41f7'], // 紫
      'midnight': ['#333333', '#111111'] // 黒
    };

    for (const key in colorStops) {
      const grad = this.boardCtx.createLinearGradient(0, 0, cellWidth, cellHeight);
      grad.addColorStop(0, colorStops[key][0]);
      grad.addColorStop(1, colorStops[key][1]);
      this.gradientCache[key] = grad;
    }

    this.highlightGradient = this.boardCtx.createLinearGradient(0, 1, 0, cellHeight * 0.35);
    this.highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
    this.highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    // 2. 角丸Path2Dキャッシュの作成
    this.pathCache = {};
    const r = 6;
    const w = cellWidth;
    const h = cellHeight;

    for (let u = 0; u <= 1; u++) {
      for (let d = 0; d <= 1; d++) {
        for (let l = 0; l <= 1; l++) {
          for (let r_dir = 0; r_dir <= 1; r_dir++) {
            const key = `${u}${d}${l}${r_dir}`;
            const path = new Path2D();
            
            const rTL = (u || l) ? 0 : r;
            const rTR = (u || r_dir) ? 0 : r;
            const rBR = (d || r_dir) ? 0 : r;
            const rBL = (d || l) ? 0 : r;
            
            path.moveTo(rTL, 0);
            path.lineTo(w - rTR, 0);
            if (rTR > 0) path.arcTo(w, 0, w, rTR, rTR);
            else path.lineTo(w, 0);
            
            path.lineTo(w, h - rBR);
            if (rBR > 0) path.arcTo(w, h, w - rBR, h, rBR);
            else path.lineTo(w, h);
            
            path.lineTo(rBL, h);
            if (rBL > 0) path.arcTo(0, h, 0, h - rBL, rBL);
            else path.lineTo(0, h);
            
            path.lineTo(0, rTL);
            if (rTL > 0) path.arcTo(0, 0, rTL, 0, rTL);
            else path.lineTo(0, 0);
            
            path.closePath();
            this.pathCache[key] = path;
          }
        }
      }
    }

    // 3. ロックの斜線パターンの作成
    const patternCanvas = document.createElement('canvas');
    patternCanvas.width = 8;
    patternCanvas.height = 8;
    const pCtx = patternCanvas.getContext('2d');
    pCtx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    pCtx.lineWidth = 1.5;
    pCtx.beginPath();
    pCtx.moveTo(0, 8);
    pCtx.lineTo(8, 0);
    pCtx.stroke();
    this.lockPattern = this.boardCtx.createPattern(patternCanvas, 'repeat');
  },

  generateBoard() {
    this.board = [];

    // マス数を横16 × 縦22に完全固定
    this.width = 16;
    this.height = 22;

    this.adjustBoardSize();

    // 5色の色が正確に均等分配されるプールを作成
    const totalCells = this.width * this.height;
    const colorsPool = [];
    const baseCount = Math.floor(totalCells / 5);
    for (let c = 1; c <= 5; c++) {
      for (let i = 0; i < baseCount; i++) {
        colorsPool.push(c);
      }
    }
    // 残りの端数はランダムに追加
    while (colorsPool.length < totalCells) {
      colorsPool.push(Math.floor(Math.random() * 5) + 1);
    }

    // シャッフル
    for (let i = colorsPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = colorsPool[i];
      colorsPool[i] = colorsPool[j];
      colorsPool[j] = temp;
    }

    let poolIdx = 0;
    for (let y = 0; y < this.height; y++) {
      const row = [];
      for (let x = 0; x < this.width; x++) {
        const color = colorsPool[poolIdx++];
        row.push({
          color,
          locked: false,
          revealed: false,
          revealCount: 0
        });
      }
      this.board.push(row);
    }

    this.updateBoardState();
    
    this.preventInitialShiningBlocks();

    this.updateBlockConnections();
  },

  preventInitialShiningBlocks() {
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      let changedAny = false;

      for (let y = 1; y < this.height - 1; y++) {
        for (let x = 1; x < this.width - 1; x++) {
          const block = this.board[y][x];
          if (!block) continue;

          // 周囲8マスの存在と色をチェック
          let isSurrounded = true;
          let surroundingColor = null;

          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const neighbor = this.board[y + dy][x + dx];
              if (!neighbor || neighbor.color === block.color) {
                isSurrounded = false;
                break;
              }
              if (surroundingColor === null) {
                surroundingColor = neighbor.color;
              } else if (neighbor.color !== surroundingColor) {
                isSurrounded = false;
                break;
              }
            }
            if (!isSurrounded) break;
          }

          // 囲まれ状態が発生している場合、真ん中あるいは周囲のどれかの色を変更して解消する
          if (isSurrounded) {
            // 真ん中のブロックの色を周囲と同じ色にする（これで結合されて囲まれが解消される）
            block.color = surroundingColor;
            changedAny = true;
          }
        }
      }

      if (!changedAny) break;
      attempts++;
    }
  },

  reroll() {
    this.score = 0;
    this.combo = 0;
    this.activeGroup = null;
    this.isGameCleared = false;
    this.generateBoard();
    this.cursor = { x: Math.floor(this.width / 2), y: Math.floor(this.height / 2) };
    Sound.playSelect();
    this.render();
  },

  updateCursorDOM() {
    this.renderBoard();
  },

  getGroup(startX, startY, visited = null) {
    const targetBlock = this.board[startY][startX];
    if (!targetBlock) return null;
    
    const color = targetBlock.color;
    const blocks = [];
    const stack = [{ x: startX, y: startY }];
    
    let localVisited = visited;
    if (!localVisited) {
      if (!this.singleVisited) {
        this.singleVisited = Array(this.height).fill(null).map(() => Array(this.width).fill(false));
      }
      localVisited = this.singleVisited;
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          localVisited[y][x] = false;
        }
      }
    }
    localVisited[startY][startX] = true;
    
    let isLocked = false;

    while (stack.length > 0) {
      const curr = stack.pop();
      blocks.push({ x: curr.x, y: curr.y });
      
      if (this.board[curr.y][curr.x].locked) {
        isLocked = true;
      }

      for (let i = 0; i < DIRS.length; i++) {
        const d = DIRS[i];
        const nx = curr.x + d.dx;
        const ny = curr.y + d.dy;

        if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
          const neighbor = this.board[ny][nx];
          if (neighbor && neighbor.color === color && !localVisited[ny][nx]) {
            localVisited[ny][nx] = true;
            stack.push({ x: nx, y: ny });
          }
        }
      }
    }

    return {
      color,
      blocks,
      locked: isLocked
    };
  },

  getAllGroups() {
    const groups = [];
    
    if (!this.groupVisited) {
      this.groupVisited = Array(this.height).fill(null).map(() => Array(this.width).fill(false));
    }
    const visited = this.groupVisited;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        visited[y][x] = false;
      }
    }

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.board[y][x] && !visited[y][x]) {
          const group = this.getGroup(x, y, visited);
          if (group) {
            groups.push(group);
          }
        }
      }
    }
    return groups;
  },

  selectGroup(group) {
    // 既存アクティブブロックの選択クラスをクリア
    if (this.activeGroup) {
      this.activeGroup.blocks.forEach(b => {
        const bl = this.board[b.y][b.x];
        if (bl && bl.el) {
          bl.el.classList.remove('active-block', 'active-shining-group');
        }
      });
    }

    this.activeGroup = group;
    if (group) {
      // グループに光るブロックが含まれているか判定
      const hasShining = group.blocks.some(b => this.board[b.y][b.x] && this.board[b.y][b.x].shining);

      group.blocks.forEach(b => {
        const bl = this.board[b.y][b.x];
        if (bl && bl.el) {
          bl.el.classList.add('active-block');
          if (hasShining) {
            bl.el.classList.add('active-shining-group');
          }
        }
      });
    }
  },

  updateBlockConnections() {
    // 1. 各マスの接続情報をリセット
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const block = this.board[y][x];
        if (block) {
          block.connUp = false;
          block.connDown = false;
          block.connLeft = false;
          block.connRight = false;
        }
      }
    }

    // 2. 結合グループ情報から接続情報を再計算（文字列キー→整数インデックスで GC 削減）
    const groups = this.getAllGroups();
    const W = this.width;
    const H = this.height;
    if (!this._groupMap || this._groupMap.length !== W * H) {
      this._groupMap = new Int16Array(W * H);
    }
    const groupMap = this._groupMap;
    groupMap.fill(-1);
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const gBlocks = groups[gIdx].blocks;
      for (let bi = 0; bi < gBlocks.length; bi++) {
        groupMap[gBlocks[bi].y * W + gBlocks[bi].x] = gIdx;
      }
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const block = this.board[y][x];
        if (block) {
          const myGroupIdx = groupMap[y * W + x];
          if (myGroupIdx < 0) {
            block.connUp = false;
            block.connDown = false;
            block.connLeft = false;
            block.connRight = false;
          } else {
            block.connUp    = (y > 0     && groupMap[(y - 1) * W + x] === myGroupIdx);
            block.connDown  = (y < H - 1 && groupMap[(y + 1) * W + x] === myGroupIdx);
            block.connLeft  = (x > 0     && groupMap[y * W + (x - 1)] === myGroupIdx);
            block.connRight = (x < W - 1 && groupMap[y * W + (x + 1)] === myGroupIdx);
          }
        }
      }
    }

    // 3. 囲まれ輝き判定（既に計算済みの groups を再利用して getAllGroups() の重複呼び出しを削減）
    this.checkShiningBlocks(groups);
  },

  checkShiningBlocks(groups) {
    if (!groups) groups = this.getAllGroups();
    // 1. まず各マス単体の「囲まれ判定」を行う（前回の判定ですでにshiningになっているものは維持）
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const block = this.board[y][x];
        if (!block) continue;
        
        if (block.shining) continue;

        let isSurrounded = true;
        let surroundingColor = null;

        if (x === 0 || x === this.width - 1 || y === 0 || y === this.height - 1) {
          isSurrounded = false;
        } else {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              const ny = y + dy;
              const neighbor = this.board[ny][nx];
              
              if (!neighbor) {
                isSurrounded = false;
                break;
              }
              if (neighbor.color === block.color) {
                isSurrounded = false;
                break;
              }
              if (surroundingColor === null) {
                surroundingColor = neighbor.color;
              } else if (neighbor.color !== surroundingColor) {
                isSurrounded = false;
                break;
              }
            }
            if (!isSurrounded) break;
          }
        }

        if (isSurrounded && surroundingColor !== null) {
          const neighbors = [];
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              neighbors.push({ x: x + dx, y: y + dy });
            }
          }

          // 周囲8マスのいずれかから連結グループを取得し、そのグループの総ブロック数がぴったり8個（中心ブロックを除く）
          // つまり、この3x3の周りの色と同じ同色グループの総サイズが正確に8個であり、
          // 周囲8マス以外の別のセルに繋がって浸食していないことを確認する。
          const surroundGroup = this.getGroup(neighbors[0].x, neighbors[0].y);
          if (surroundGroup && surroundGroup.blocks.length === 8) {
            // グループの全ブロックがこの周囲8マスの中にぴったり収まっているかを検証
            const neighborSet = new Set(neighbors.map(n => `${n.x},${n.y}`));
            let allContained = true;
            for (const sb of surroundGroup.blocks) {
              if (!neighborSet.has(`${sb.x},${sb.y}`)) {
                allContained = false;
                break;
              }
            }
            if (allContained) {
              block.shining = true;
            }
          }
        }
      }
    }

    // 2. グループ（結合塊）ごとに走査し、塊の中に1枚でもshiningのブロックがあれば、塊全体をshiningにする
    groups.forEach(g => {
      const hasShiningBlock = g.blocks.some(b => this.board[b.y][b.x] && this.board[b.y][b.x].shining);
      
      g.blocks.forEach(b => {
        const block = this.board[b.y][b.x];
        if (block) {
          block.shining = hasShiningBlock;
        }
      });
    });
  },

  checkMergeAndUnlock(targetBlocks, color) {
    const targetSet = new Set(targetBlocks.map(b => `${b.x},${b.y}`));
    const adjacentSameColorBlocks = [];
    const dirs = DIRS;
    
    for (const b of targetBlocks) {
      for (const d of dirs) {
        const nx = b.x + d.dx;
        const ny = b.y + d.dy;
        
        if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
          if (!targetSet.has(`${nx},${ny}`)) {
            const neighbor = this.board[ny][nx];
            if (neighbor && neighbor.color === color) {
              adjacentSameColorBlocks.push({ x: nx, y: ny });
            }
          }
        }
      }
    }

    if (adjacentSameColorBlocks.length > 0) {
      const mergedGroup = this.getGroup(targetBlocks[0].x, targetBlocks[0].y);
      if (mergedGroup) {
        for (const b of mergedGroup.blocks) {
          if (this.board[b.y][b.x]) {
            this.board[b.y][b.x].locked = false;
          }
        }
        return true;
      }
    }
    return false;
  },

  // 盤面データの一手バックアップを保存するユーティリティメソッド
  backupForUndo(actionType = 'general', actionData = {}) {
    this.undoHistory = {
      actionType,
      actionData,
      score: this.score,
      combo: this.combo,
      gameMode: this.gameMode,
      nextGravityDirection: this.nextGravityDirection ? { ...this.nextGravityDirection } : null,
      // スキル残数をディープコピーしてバックアップ
      skills: {
        undo: { count: this.skills.undo.count, max: this.skills.undo.max },
        move: { count: this.skills.move.count, max: this.skills.move.max },
        change: { count: this.skills.change.count, max: this.skills.change.max }
      },
      board: this.board.map(row => row.map(cell => {
        if (!cell) return null;
        return {
          color: cell.color,
          locked: cell.locked,
          shining: cell.shining,
          revealed: cell.revealed,
          revealCount: cell.revealCount
        };
      }))
    };
  },

  slideActiveGroup(dx, dy) {
    if (!this.activeGroup || this.isAnimating) return;

    if (this.activeGroup.locked) {
      Sound.playCancel();
      return;
    }

    const blocks = this.activeGroup.blocks;
    const color = this.activeGroup.color;
    const activeSet = new Set(blocks.map(b => `${b.x},${b.y}`));
    
    let steps = 0;
    let canMove = true;
    
    while (canMove) {
      const nextSteps = steps + 1;
      
      for (const b of blocks) {
        const nx = b.x + dx * nextSteps;
        const ny = b.y + dy * nextSteps;
        
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) {
          canMove = false;
          break;
        }
        
        const targetCell = this.board[ny][nx];
        if (targetCell && !activeSet.has(`${nx},${ny}`)) {
          canMove = false;
          break;
        }
      }
      
      if (canMove) {
        steps++;
      }
    }

    if (steps === 0) {
      Sound.playCancel();
      return;
    }

    // スライド直前に一手戻るための履歴を保存（アクションタイプ: slide）
    const movedBlocks = blocks.map(b => ({
      from: { x: b.x, y: b.y },
      to: { x: b.x + dx * steps, y: b.y + dy * steps }
    }));
    this.backupForUndo('slide', { movedBlocks });

    this.isAnimating = true;

    // Canvasアニメーションの設定
    const moving = blocks.map(b => {
      const cell = this.board[b.y][b.x];
      return {
        fromX: b.x,
        fromY: b.y,
        toX: b.x + dx * steps,
        toY: b.y + dy * steps,
        color: cell.color,
        locked: cell.locked,
        shining: cell.shining,
        revealed: cell.revealed,
        connUp: cell.connUp,
        connDown: cell.connDown,
        connLeft: cell.connLeft,
        connRight: cell.connRight
      };
    });

    this.currentAnimations = {
      type: 'slide',
      startTime: performance.now(),
      duration: 80, // ms
      blocks: moving
    };
    this.startBoardLoop(); // 描画ループ起動

    setTimeout(() => {
      this.currentAnimations = null;
      this.stopBoardLoop(); // 描画ループ停止

      const movingBlocks = [];
      for (const b of blocks) {
        movingBlocks.push({
          from: { x: b.x, y: b.y },
          to: { x: b.x + dx * steps, y: b.y + dy * steps },
          data: this.board[b.y][b.x]
        });
        this.board[b.y][b.x] = null;
      }
      
      for (const mb of movingBlocks) {
        this.board[mb.to.y][mb.to.x] = {
          color: mb.data.color,
          locked: true,
          shining: mb.data.shining,
          revealed: mb.data.revealed || false,
          revealCount: mb.data.revealCount || 0
        };
      }

      const newBlocks = movingBlocks.map(mb => mb.to);
      const merged = this.checkMergeAndUnlock(newBlocks, color);
      
      if (merged) {
        Sound.playSelect();
        
        const mergedGroup = this.getGroup(newBlocks[0].x, newBlocks[0].y);
        if (mergedGroup) {
          for (const b of mergedGroup.blocks) {
            const block = this.board[b.y][b.x];
            if (block) {
              block.locked = false;
            }
          }
        }
      } else {
        this.combo = 0;
        Sound.playCancel();
        
        for (const mb of newBlocks) {
          const block = this.board[mb.y][mb.x];
          if (block) {
            block.locked = true;
          }
        }
      }

      this.cursor = { x: newBlocks[0].x, y: newBlocks[0].y };
      this.activeGroup = null;
      this.isAnimating = false;
      
      if (this.gameMode === 'GRAVITY') {
        this.triggerGravityShift(() => {
          this.updateBlockConnections();
          this.checkGameOver();
          this.render();
        });
      } else {
        if (this.gameMode === 'MIDNIGHT') {
          newBlocks.forEach(mb => {
            this.exposeAdjacentSameColorBlocks(mb.x, mb.y);
          });
          this.advanceMidnightTurn();
        }

        this.updateBlockConnections();
        this.checkGameOver();
        this.render();
      }
    }, 80);
  },

  // Canvas上にパーティクルを追加
  createParticles(blocks, colorHex) {
    if (!this.canvas) return;
    
    const rect = this.canvas.getBoundingClientRect();

    // パフォーマンス維持：画面上の総パーティクル数を最大120個に制限し、古いものからカット
    if (this.particles.length > 120) {
      this.particles.splice(0, this.particles.length - 120);
    }

    // 消去するブロック数に応じて1ブロックあたりの粒子数を動的に抑え、重くならないように上限を設ける
    // 2〜5個: 1セルあたり5粒子, 6〜15個: 3粒子, それ以上: 2粒子
    let particleCountPerCell = 5;
    if (blocks.length > 15) {
      particleCountPerCell = 2;
    } else if (blocks.length > 5) {
      particleCountPerCell = 3;
    }

    if (!this.boardCanvas) return;
    const boardRect = this.boardCanvas.getBoundingClientRect();
    // 【最適化】adjustCanvasSize と同じ上限2.0を適用し、canvas.width/height の実寸と整合させる
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const boardWidth = this.boardCanvas.width / dpr;
    const boardHeight = this.boardCanvas.height / dpr;
    const cellWidth = boardWidth / this.width;
    const cellHeight = boardHeight / this.height;

    blocks.forEach(b => {
      const localX = b.x * cellWidth + cellWidth / 2;
      const localY = b.y * cellHeight + cellHeight / 2;
      const centerX = boardRect.left - rect.left + localX;
      const centerY = boardRect.top - rect.top + localY;

      for (let i = 0; i < particleCountPerCell; i++) {
        const angle = Math.random() * Math.PI * 2;
        // 粒子スピードをアップしてよりダイナミックに拡散させる
        const speed = Math.random() * 6 + 3;
        
        this.particles.push({
          x: centerX,
          y: centerY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.8, // 上方向への勢いを強化
          color: colorHex,
          // 粒子サイズを以前（3~8px）から大幅に大きく（8~16px）して派手にする
          size: Math.random() * 8 + 8,
          opacity: 1.0,
          decay: Math.random() * 0.03 + 0.025 // 少しだけ速めに消えるようにしてパフォーマンスを維持
        });
      }
    });

    this.startEffectsLoop();
  },

  // Canvas上にテキストポップアップを追加
  createComboPopup(x, y, comboText, colorHex, scale) {
    if (!this.canvas) return;

    this.popups.push({
      x: x,
      y: y,
      text: comboText,
      color: colorHex,
      opacity: 1.0,
      scale: scale,
      timer: 0
    });

    this.startEffectsLoop();
  },

  startEffectsLoop() {
    if (this.isLoopingEffects) return;
    this.isLoopingEffects = true;
    this.loopEffects();
  },

  // Canvasエフェクト描画ループ
  loopEffects() {
    if (!this.ctx || !this.canvas) return;

    // 【最適化】高リフレッシュレート端末（90/120Hz等）でも60FPS(約16.67ms間隔)を超えて
    // 更新・描画しないよう制限する。requestAnimationFrame自体は毎回呼び続け、
    // 間隔が短い場合は処理をスキップして次フレームへ回す。
    // パーティクル/ポップアップの物理演算は1フレーム単位の加算式のため、
    // 実効更新頻度を60FPSに揃えることで既存の速度感・見た目は変わらない。
    const now = performance.now();
    const elapsed = now - (this._lastEffectsFrameTime || 0);
    const FRAME_INTERVAL = 1000 / 60;

    if (elapsed < FRAME_INTERVAL) {
      requestAnimationFrame(() => this.loopEffects());
      return;
    }
    this._lastEffectsFrameTime = now - (elapsed % FRAME_INTERVAL);

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    let hasActiveEffects = false;

    // 1. パーティクル更新・描画
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += 0.22;
      p.vx *= 0.97;
      p.vy *= 0.97;
      p.x += p.vx;
      p.y += p.vy;
      p.opacity -= p.decay;

      if (p.opacity <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      hasActiveEffects = true;

      this.ctx.save();
      this.ctx.globalAlpha = p.opacity;
      this.ctx.fillStyle = p.color;
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }

    // 2. ポップアップテキスト更新・描画 (消去数ポップアップ)
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const pop = this.popups[i];
      pop.timer += 1;

      if (pop.timer < 10) {
        pop.scale += 0.06;
        pop.y -= 1.0;
      } else if (pop.timer > 30) {
        pop.opacity -= 0.05;
        pop.y -= 0.8;
      } else {
        pop.y -= 0.3;
      }

      if (pop.opacity <= 0) {
        this.popups.splice(i, 1);
        continue;
      }

      hasActiveEffects = true;

      this.ctx.save();
      this.ctx.globalAlpha = pop.opacity;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.font = `800 ${14 * pop.scale}px 'Outfit', sans-serif`;
      
      // モバイルで極めて高負荷な ctx.shadowBlur / shadowColor を無効化し、太いストローク枠線で代用
      this.ctx.strokeStyle = '#05070f';
      this.ctx.lineWidth = 5; // ストローク幅を太くして視認性を維持
      this.ctx.strokeText(pop.text, pop.x, pop.y);
      
      this.ctx.fillStyle = '#fbbf24';
      this.ctx.fillText(pop.text, pop.x, pop.y);
      this.ctx.restore();
    }

    if (hasActiveEffects && (this.state === 'PLAYING' || this.state === 'GAME_OVER' || this.state === 'DIALOG')) {
      requestAnimationFrame(() => this.loopEffects());
    } else {
      this.isLoopingEffects = false;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  },

  clearActiveGroup() {
    if (!this.activeGroup || this.isAnimating) return;

    const size = this.activeGroup.blocks.length;
    if (size < 2) {
      Sound.playCancel();
      return;
    }

    // ブロック消去直前に一手戻るための履歴を保存（アクションタイプ: clear）
    const clearedBlocks = this.activeGroup.blocks.map(b => ({
      x: b.x,
      y: b.y,
      color: this.board[b.y][b.x].color,
      locked: this.board[b.y][b.x].locked
    }));
    this.backupForUndo('clear', { clearedBlocks });

    const colorHex = this.colors[this.activeGroup.color].hex;

    // 消去前に画面上の中心座標をあらかじめ算出する
    let sumX = 0, sumY = 0;
    let count = 0;
    if (this.boardCanvas) {
      const rect = this.boardCanvas.getBoundingClientRect();
      const cellWidth = rect.width / this.width;
      const cellHeight = rect.height / this.height;
      this.activeGroup.blocks.forEach(b => {
        sumX += b.x * cellWidth + cellWidth / 2;
        sumY += b.y * cellHeight + cellHeight / 2;
        count++;
      });
    }
    const centerX = count > 0 ? (sumX / count) : 0;
    const centerY = count > 0 ? (sumY / count) : 0;

    // 1. パーティクルをCanvasに追加
    this.createParticles(this.activeGroup.blocks, colorHex);

    // 外枠を光らせてラインが走る演出を実行
    const runner = document.getElementById('border-light-runner');
    if (runner) {
      // 消したブロックの色に応じたネオンカラークラスをマッピング (1: 赤, 2: 青, 3: 緑, 4: 黄, 5: 紫)
      const colorNames = { 1: 'red', 2: 'blue', 3: 'green', 4: 'yellow', 5: 'purple' };
      const colorSuffix = colorNames[this.activeGroup.color] || 'blue';
      
      console.log("Border laser clear color ID:", this.activeGroup.color, "Class suffix:", colorSuffix); // デバッグ用

      // アニメーションクラスを一度完全に初期化
      runner.className = 'border-light-runner';
      
      // 同期リフローを発生させてブラウザに変更を強制認識させる
      const forceReflow = runner.offsetWidth; 
      
      // 同一スレッドで即座に新しいカラークラスを付与
      runner.classList.add('trail-active', `trail-${colorSuffix}`);
    }

    // 隠し仕様：この塊の中に光る（shining）ブロックが含まれているか判定
    let hasShiningBlock = false;
    for (const b of this.activeGroup.blocks) {
      const block = this.board[b.y][b.x];
      if (block && block.shining) {
        hasShiningBlock = true;
        break;
      }
    }

    // ブロック削除 (配列のクリア)
    for (const b of this.activeGroup.blocks) {
      this.board[b.y][b.x] = null;
    }

    if (this.gameMode === 'MIDNIGHT') {
      // ターン進行（露出カウント減少）
      this.advanceMidnightTurn();
    }

    // 光るブロックを含んでいた場合、消去数を倍にして計算する
    const effectiveSize = hasShiningBlock ? size * 2 : size;

    const scoreAdd = Math.floor(Math.pow(effectiveSize, 2.5) * 100 * (1 + this.combo * 0.1));
    this.score += scoreAdd;
    this.combo += 1;
    
    // 2. 消去ブロック数のポップアップをCanvasに追加
    const popupText = hasShiningBlock ? `${size} × 2 = ${effectiveSize} Blocks!` : `${size} Blocks!`;
    
    // 消した数が大きければ大きいほど表示を大きくするスケール計算
    // 2個 = 0.6 (最小)
    // 64個以上 = 3.2 (最大) ➔ 画面左右いっぱいに近いサイズ感
    const scale = 0.6 + Math.min(2.6, (effectiveSize - 2) * (2.6 / 62));
    
    this.createComboPopup(centerX, centerY, popupText, colorHex, scale);

    Stats.addBlocksCleared(effectiveSize);
    Stats.updateMaxCombo(this.combo);
    
    Sound.playClear();
    setTimeout(() => {
      Sound.playCombo(this.combo);
    }, 100);

    this.activeGroup = null;

    let isAllCleared = true;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.board[y][x] !== null) {
          isAllCleared = false;
          break;
        }
      }
      if (!isAllCleared) break;
    }

    if (isAllCleared) {
      // 合計スコアが現在の1.5倍になるように、現在のスコアの50%分をボーナス加算
      const bonus = Math.floor(this.score * 0.5);
      this.score += bonus;
      this.isGameCleared = true;
      
      this.showDialog(
        `ALL CLEAR BONUS (1.5x)!\n+${bonus.toLocaleString()}`,
        ['OK'],
        () => {
          this.saveLocalBest();
          this.state = 'GAME_OVER';
          this.menuIndex = 0;
          this.render();
        }
      );
    } else {
      if (this.gameMode === 'GRAVITY') {
        this.triggerGravityShift(() => {
          this.updateBlockConnections();
          this.checkGameOver();
          this.render();
        });
      } else {
        this.updateBlockConnections();
        this.checkGameOver();
        this.render();
      }
    }
  },

  checkGameOver() {
    let hasBlocks = false;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.board[y][x] !== null) {
          hasBlocks = true;
          break;
        }
      }
      if (hasBlocks) break;
    }
    if (!hasBlocks) return;

    const allGroups = this.getAllGroups();
    
    let canAction = false;
    for (const g of allGroups) {
      if (g.blocks.length >= 2 || !g.locked) {
        canAction = true;
        break;
      }
    }

    if (!canAction) {
      setTimeout(() => {
        this.saveLocalBest();
        this.state = 'GAME_OVER';
        Sound.playCancel();
        this.render();
      }, 500);
    }
  },

  // キーボードイベント処理
  handleKeyDown(e) {
    if (typeof activateAudio === 'function') {
      activateAudio();
    } else {
      Sound.init();
      Sound.resume();
      if (Sound.bgmEnabled && !Sound.bgmPlaying) Sound.playBgm();
    }
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      if (e.key === 'Enter') {
        document.activeElement.blur();
        this.render();
      }
      return;
    }
    if (this.isAnimating) return;
    
    let key = e.key;
    if (key === 'Up') key = 'ArrowUp';
    if (key === 'Down') key = 'ArrowDown';
    if (key === 'Left') key = 'ArrowLeft';
    if (key === 'Right') key = 'ArrowRight';
    if (key === 'Esc') key = 'Escape';

    this.inputMode = 'KEYBOARD';
    this.updateCursorDOM();

    if (this.state === 'DIALOG') {
      const maxChoices = this.dialogChoices.length;
      if (key === 'ArrowUp') {
        if (this.isColorSelect) {
          if (this.dialogMenuIndex === 4) {
            this.dialogMenuIndex = 1; // 4色の中央付近（2つ目のボタン）にジャンプ
          } else {
            this.dialogMenuIndex = 4; // キャンセルボタンにフォーカス
          }
        } else {
          this.dialogMenuIndex = (this.dialogMenuIndex - 1 + maxChoices) % maxChoices;
        }
        Sound.playCursor();
        this.renderDialogChoices();
      } else if (key === 'ArrowDown') {
        if (this.isColorSelect) {
          if (this.dialogMenuIndex === 4) {
            this.dialogMenuIndex = 1; // 4色の中央付近にジャンプ
          } else {
            this.dialogMenuIndex = 4; // キャンセルボタンにフォーカス
          }
        } else {
          this.dialogMenuIndex = (this.dialogMenuIndex + 1) % maxChoices;
        }
        Sound.playCursor();
        this.renderDialogChoices();
      } else if (key === 'ArrowLeft') {
        if (this.isColorSelect) {
          this.dialogMenuIndex = (this.dialogMenuIndex - 1 + maxChoices) % maxChoices;
          Sound.playCursor();
          this.renderDialogChoices();
        }
      } else if (key === 'ArrowRight') {
        if (this.isColorSelect) {
          this.dialogMenuIndex = (this.dialogMenuIndex + 1) % maxChoices;
          Sound.playCursor();
          this.renderDialogChoices();
        }
      } else if (key === 'Enter') {
        Sound.playSelect();
        const callback = this.dialogCallback;
        const selectedIndex = this.dialogMenuIndex;
        this.closeDialog();
        if (callback) callback(selectedIndex);
      } else if (key === 'Escape') {
        Sound.playCancel();
        this.closeDialog();
      }
      return;
    }

    if (this.state === 'TITLE') {
      if (key === 'ArrowUp') {
        this.menuIndex = (this.menuIndex - 1 + 4) % 4;
        Sound.playCursor();
        this.render();
      } else if (key === 'ArrowDown') {
        this.menuIndex = (this.menuIndex + 1) % 4;
        Sound.playCursor();
        this.render();
      } else if (key === 'Enter') {
        Sound.playSelect();
        if (this.menuIndex === 0) {
          if (this.hasSuspendedGame()) {
            this.showDialog(
              "中断したデータがあります。\n再開しますか？",
              ["再開する", "最初から"],
              (idx) => {
                if (idx === 0) {
                  this.resumeSuspendedGame();
                } else {
                  this.clearSuspendedGame();
                  this.startNewGame();
                }
              }
            );
          } else {
            this.startNewGame();
          }
        } else if (this.menuIndex === 1) {
          this.viewingHelpMode = this.gameMode === 'GRAVITY' ? 'GRAVITY' : (this.gameMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'CLASSIC');
          this.state = 'HELP_VIEW';
          this.render();
        } else if (this.menuIndex === 2) {
          this.settingsTemp = {
            bgm: Sound.bgmEnabled,
            sound: Sound.enabled,
            background: this.backgroundType,
            width: this.width,
            height: this.height
          };
          this.menuIndex = 0;
          this.state = 'SETTINGS';
          this.render();
        } else if (this.menuIndex === 3) {
          this.viewingRankMode = this.gameMode === 'GRAVITY' ? 'GRAVITY' : (this.gameMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'CLASSIC');
          this.state = 'RANKING_VIEW';
          this.render();
        }
      }
    }
    
    else if (this.state === 'SETTINGS') {
      const settingsCount = 7; // 名前(0)、BGM(1)、SE(2)、背景(3)、集計(4)、消去(5)、保存(6)
      if (key === 'ArrowUp') {
        this.menuIndex = (this.menuIndex - 1 + settingsCount) % settingsCount;
        Sound.playCursor();
        this.render();
      } else if (key === 'ArrowDown') {
        this.menuIndex = (this.menuIndex + 1) % settingsCount;
        Sound.playCursor();
        this.render();
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (this.menuIndex === 1) {
          this.settingsTemp.bgm = !this.settingsTemp.bgm;
          Sound.setBgmEnabled(this.settingsTemp.bgm);
          Sound.playCursor();
        } else if (this.menuIndex === 2) {
          this.settingsTemp.sound = !this.settingsTemp.sound;
          Sound.playCursor();
        } else if (this.menuIndex === 3) {
          this.settingsTemp.background = this.settingsTemp.background === 'city' ? 'normal' : 'city';
          Sound.playCursor();
        }
        this.render();
      } else if (key === 'Enter') {
        if (this.menuIndex === 0) {
          const nameInput = document.getElementById('player-name-input');
          if (nameInput) nameInput.focus();
        } else if (this.menuIndex === 1) {
          this.settingsTemp.bgm = !this.settingsTemp.bgm;
          Sound.setBgmEnabled(this.settingsTemp.bgm);
          Sound.playSelect();
          this.render();
        } else if (this.menuIndex === 2) {
          this.settingsTemp.sound = !this.settingsTemp.sound;
          Sound.playSelect();
          this.render();
        } else if (this.menuIndex === 3) {
          this.settingsTemp.background = this.settingsTemp.background === 'city' ? 'normal' : 'city';
          Sound.playSelect();
          this.render();
        } else if (this.menuIndex === 4) {
          Sound.playSelect();
          this.state = 'STATS_VIEW';
          this.render();
        } else if (this.menuIndex === 5) {
          Sound.playSelect();
          this.showDialog(
            "RESET ALL YOUR BEST SCORES?",
            ["NO", "YES"],
            (choice) => {
              if (choice === 1) {
                localStorage.removeItem('my_best_score_record');
                localStorage.removeItem('my_best_score_record_gravity');
                localStorage.removeItem('my_best_score_record_midnight');
                localStorage.removeItem('imode_puzzle_my_history');
                localStorage.removeItem('imode_puzzle_my_history_gravity');
                localStorage.removeItem('imode_puzzle_my_history_midnight');
                localStorage.removeItem('block_slider_remove_ads');
                this.bestScore = 0;
                this.render();
                Sound.playCancel();
                this.showDialog("BEST SCORES RESET.", ["CLOSE"], null);
              }
            }
          );
        } else if (this.menuIndex === 6) {
          Sound.playSelect();
          const nameInput = document.getElementById('player-name-input');
          if (nameInput) {
            this.playerName = nameInput.value.trim() || 'プレイヤー';
            localStorage.setItem('imode_puzzle_player_name', this.playerName);
          }
          Sound.setBgmEnabled(this.settingsTemp.bgm);
          Sound.enabled = this.settingsTemp.sound;
          this.soundEnabled = Sound.enabled;
          this.bgmEnabled = Sound.bgmEnabled;

          this.backgroundType = this.settingsTemp.background;
          localStorage.setItem('imode_puzzle_background', this.backgroundType);
          this.applyBackground(this.backgroundType);

          this.width = 16;
          this.height = 22;

          this.backToTitle(false); // キーボード保存終了時もリロールを行わない
        }
      } else if (key === 'Escape') {
        Sound.playCancel();
        this.backToTitle(false);
      }
    }

    else if (this.state === 'STATS_VIEW') {
      if (key === 'Enter' || key === 'Escape') {
        Sound.playCancel();
        this.backToTitle(false);
      }
    }

    else if (this.state === 'HELP_VIEW') {
      if (key === 'Enter' || key === 'Escape') {
        Sound.playCancel();
        this.backToTitle(false);
      }
    }

    else if (this.state === 'PLAYING') {
      if (this.activeGroup) {
        if (key === 'ArrowUp') {
          if (this.skillActiveMode === 'MOVE') {
            this.keyboardMoveGroup(0, -1);
          } else {
            this.slideActiveGroup(0, -1);
          }
        } else if (key === 'ArrowDown') {
          if (this.skillActiveMode === 'MOVE') {
            this.keyboardMoveGroup(0, 1);
          } else {
            this.slideActiveGroup(0, 1);
          }
        } else if (key === 'ArrowLeft') {
          if (this.skillActiveMode === 'MOVE') {
            this.keyboardMoveGroup(-1, 0);
          } else {
            this.slideActiveGroup(-1, 0);
          }
        } else if (key === 'ArrowRight') {
          if (this.skillActiveMode === 'MOVE') {
            this.keyboardMoveGroup(1, 0);
          } else {
            this.slideActiveGroup(1, 0);
          }
        } else if (key === 'Enter') {
          if (this.skillActiveMode === 'MOVE') {
            // キーボード操作：現在の位置でMOVE移動を確定
            if (this.moveSkillStartBlocks) {
              const movedBlocks = this.moveSkillStartBlocks.map((start, idx) => ({
                from: start,
                to: this.activeGroup.blocks[idx]
              }));
              this.backupForUndo('move', { movedBlocks });
            }
            this.skills.move.count = 0; // スキル消費
            // キーボード操作での移動完了後のアンロック判定
            const movedCoords = this.activeGroup.blocks;
            this.updateBlockConnections(); // 接続関係を再計算
            
            const firstBlock = movedCoords[0];
            const targetColor = this.board[firstBlock.y][firstBlock.x].color;
            const merged = this.checkMergeAndUnlock(movedCoords, targetColor);
            
            if (merged) {
              const mergedGroup = this.getGroup(firstBlock.x, firstBlock.y);
              if (mergedGroup) {
                for (const b of mergedGroup.blocks) {
                  const block = this.board[b.y][b.x];
                  if (block) {
                    block.locked = false;
                    if (block.el) {
                      block.el.classList.remove('block-locked');
                    }
                  }
                }
              }
            }

            this.activeGroup = null;
            this.skillActiveMode = null;
            this.moveSkillStartBlocks = null;
            
            if (this.gameMode === 'GRAVITY') {
              this.triggerGravityShift(() => {
                this.updateBlockConnections();
                this.checkGameOver();
                this.render();
                Sound.playSelect();
              });
            } else {
              this.updateBlockConnections();
              this.checkGameOver();
              this.render();
              Sound.playSelect();
            }
          } else {
            this.clearActiveGroup();
          }
        } else if (key === 'Escape') {
          if (this.skillActiveMode === 'MOVE') {
            // キーボード操作：MOVE移動キャンセル（元に戻す）
            if (this.moveSkillStartBlocks) {
              // startブロックの位置に移動させる
              const startCoords = this.moveSkillStartBlocks;
              const moving = [];
              this.activeGroup.blocks.forEach((b, idx) => {
                moving.push({
                  from: { x: b.x, y: b.y },
                  to: { x: startCoords[idx].x, y: startCoords[idx].y },
                  data: this.board[b.y][b.x]
                });
                this.board[b.y][b.x] = null;
              });
              moving.forEach(m => {
                this.board[m.to.y][m.to.x] = {
                  color: m.data.color,
                  locked: m.data.locked,
                  el: m.data.el
                };
                if (m.data.el) {
                  m.data.el.style.left = `${(100 / this.width) * m.to.x}%`;
                  m.data.el.style.top = `${(100 / this.height) * m.to.y}%`;
                  m.data.el.dataset.x = m.to.x;
                  m.data.el.dataset.y = m.to.y;
                }
              });
            }
            this.moveSkillStartBlocks = null;
          }

          this.selectGroup(null);
          this.skillActiveMode = null;
          Sound.playCancel();
          this.render();
        }
      } else {
        if (key === 'ArrowUp') {
          this.cursor.y = (this.cursor.y - 1 + this.height) % this.height;
          Sound.playCursor();
        } else if (key === 'ArrowDown') {
          this.cursor.y = (this.cursor.y + 1) % this.height;
          Sound.playCursor();
        } else if (key === 'ArrowLeft') {
          this.cursor.x = (this.cursor.x - 1 + this.width) % this.width;
          Sound.playCursor();
        } else if (key === 'ArrowRight') {
          this.cursor.x = (this.cursor.x + 1) % this.width;
          Sound.playCursor();
        } else if (key === 'Enter') {
          // MOVE / CHANGE スキル発動時の確定操作
          if (this.skillActiveMode === 'CHANGE') {
            const group = this.getGroup(this.cursor.x, this.cursor.y);
            if (group) {
              if (this.activeGroup && this.activeGroup.blocks.some(b => b.x === this.cursor.x && b.y === this.cursor.y)) {
                this.triggerChangeSkill(this.cursor.x, this.cursor.y);
              } else {
                this.selectGroup(group);
                Sound.playSelect();
              }
            } else {
              Sound.playCancel();
            }
            return;
          }
          if (this.skillActiveMode === 'MOVE') {
            const group = this.getGroup(this.cursor.x, this.cursor.y);
            if (group) {
              this.selectGroup(group);
              Sound.playSelect();
            } else {
              Sound.playCancel();
            }
            return;
          }

          const group = this.getGroup(this.cursor.x, this.cursor.y);
          if (group) {
            this.selectGroup(group);
            Sound.playSelect();
          } else {
            Sound.playCancel();
          }
        } else if (key === '1') {
          this.triggerUndo();
        } else if (key === '2') {
          this.setSkillMode('MOVE');
        } else if (key === '3') {
          this.setSkillMode('CHANGE');
        } else if (key === 'Escape') {
          if (this.skillActiveMode) {
            this.skillActiveMode = null;
            this.skillSelectedGroup = null;
            Sound.playCancel();
          } else {
            this.showPauseMenu();
          }
        }
        this.render();
      }
    }

    else if (this.state === 'GAME_OVER') {
      const maxChoices = this.score > 0 ? 2 : 1;
      if (key === 'ArrowUp') {
        this.menuIndex = (this.menuIndex - 1 + maxChoices) % maxChoices;
        Sound.playCursor();
        this.render();
      } else if (key === 'ArrowDown') {
        this.menuIndex = (this.menuIndex + 1) % maxChoices;
        Sound.playCursor();
        this.render();
      } else if (key === 'Enter') {
        if (this.menuIndex === 0) {
          Sound.playCancel();
          this.backToTitle(true);
        } else if (this.menuIndex === 1 && this.score > 0) {
          this.submitScore();
        }
      }
    }

    else if (this.state === 'RANKING_VIEW') {
      if (key === 'ArrowUp') {
        this.menuIndex = (this.menuIndex - 1 + 3) % 3;
        Sound.playCursor();
        this.render();
      } else if (key === 'ArrowDown') {
        this.menuIndex = (this.menuIndex + 1) % 3;
        Sound.playCursor();
        this.render();
      } else if (key === 'Enter') {
        if (this.menuIndex === 0) {
          Sound.playSelect();
          this.rankingMode = 'ALL';
          this.render();
        } else if (this.menuIndex === 1) {
          Sound.playSelect();
          this.rankingMode = 'MY';
          this.render();
        } else if (this.menuIndex === 2) {
          Sound.playSelect();
          this.backToTitle(true);
        }
      } else if (key === 'Escape') {
        Sound.playCancel();
        this.backToTitle(true);
      }
    }
  },

  // 統合されたポーズメニューを表示
  showPauseMenu() {
    this.showDialog(
      'SELECT an OPTION',
      ['RESUME', 'RETURN to TITLE', 'GIVE UP'],
      (selectedIdx) => {
        if (selectedIdx === 1) {
          Sound.playSelect();
          this.saveSuspendedGame();
          this.backToTitle(true);
        } else if (selectedIdx === 2) {
          Sound.playCancel();
          this.saveLocalBest();
          this.state = 'GAME_OVER';
          this.render();
        }
      }
    );
  },

  // マウス/タッチドラッグ・タップのハイブリッド操作ハンドラー
  setupEventListeners() {
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));

    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    const getEventCoords = (e) => {
      if (e.touches && e.touches.length > 0) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      return { x: e.clientX, y: e.clientY };
    };

    const onDragStart = (e) => {
      if (this.state !== 'PLAYING' || this.isAnimating) return;
      
      this.inputMode = 'MOUSE';
      this.updateCursorDOM();
      this._dragSessionId++; // 【最適化】ドラッグ中の静止レイヤーキャッシュ識別用

      const coords = getEventCoords(e);
      this.dragStart = {
        x: coords.x,
        y: coords.y,
        time: Date.now()
      };
      this.dragActive = true;

      // タッチ座標からグリッド位置を逆算
      const rect = this.boardCanvas.getBoundingClientRect();
      const mouseX = coords.x - rect.left;
      const mouseY = coords.y - rect.top;
      const cellWidth = rect.width / this.width;
      const cellHeight = rect.height / this.height;
      const gx = Math.floor(mouseX / cellWidth);
      const gy = Math.floor(mouseY / cellHeight);

      if (gx >= 0 && gx < this.width && gy >= 0 && gy < this.height) {
        this.draggedGrid = { x: gx, y: gy };

        // MOVEスキルモードかつ対象が未決定の場合、最初にタップしたグループをアクティブにする
        if (this.skillActiveMode === 'MOVE' && !this.activeGroup) {
          const group = this.getGroup(gx, gy);
          if (group) {
            this.selectGroup(group);
            Sound.playSelect();
          }
        }
      } else {
        this.draggedGrid = null;
      }
    };

    const onDragMove = (e) => {
      if (!this.dragActive || this.isAnimating) return;

      const coords = getEventCoords(e);
      const diffX = coords.x - this.dragStart.x;
      const diffY = coords.y - this.dragStart.y;

      if (this.skillActiveMode === 'MOVE' && this.activeGroup) {
        // MOVEスキル：ドラッグオフセットを設定して再描画を回す
        this.dragOffset = { x: diffX, y: diffY };
        this.startBoardLoop(); // 描画ループ起動
        return;
      }

      const dist = Math.sqrt(diffX * diffX + diffY * diffY);
      if (dist > 25 && this.draggedGrid) {
        let dx = 0, dy = 0;
        if (Math.abs(diffX) > Math.abs(diffY)) {
          dx = diffX > 0 ? 1 : -1;
        } else {
          dy = diffY > 0 ? 1 : -1;
        }

        const block = this.board[this.draggedGrid.y][this.draggedGrid.x];
        if (block) {
          const group = this.getGroup(this.draggedGrid.x, this.draggedGrid.y);
          if (group && !group.locked) {
            this.selectGroup(group);
            this.cursor = { x: this.draggedGrid.x, y: this.draggedGrid.y };
            this.updateCursorDOM();

            this.slideActiveGroup(dx, dy);
          }
        }
        
        this.dragActive = false;
      }
    };

    const onDragEnd = (e) => {
      if (!this.dragActive) return;
      this.dragActive = false;

      const coords = e.changedTouches ? 
        { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY } : 
        { x: e.clientX, y: e.clientY };

      const diffX = coords.x - this.dragStart.x;
      const diffY = coords.y - this.dragStart.y;
      const dist = Math.sqrt(diffX * diffX + diffY * diffY);
      const duration = Date.now() - this.dragStart.time;

      if (this.skillActiveMode === 'MOVE' && this.activeGroup) {
        this.dragOffset = null; // ドラッグオフセットをクリア
        
        const rect = this.boardCanvas.getBoundingClientRect();
        const cellWidth = rect.width / this.width;
        const cellHeight = rect.height / this.height;

        const dx = Math.round(diffX / cellWidth);
        const dy = Math.round(diffY / cellHeight);

        let valid = true;
        const movingSet = new Set(this.activeGroup.blocks.map(b => `${b.x},${b.y}`));

        for (const b of this.activeGroup.blocks) {
          const nx = b.x + dx;
          const ny = b.y + dy;
          if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) {
            valid = false;
            break;
          }
          const target = this.board[ny][nx];
          if (target && !movingSet.has(`${nx},${ny}`)) {
            valid = false;
            break;
          }
        }

        if (valid && (dx !== 0 || dy !== 0)) {
          // 移動履歴保存＆移動確定
          const movedBlocks = this.activeGroup.blocks.map(b => ({
            from: { x: b.x, y: b.y },
            to: { x: b.x + dx, y: b.y + dy }
          }));
          this.backupForUndo('move', { movedBlocks });
          this.skills.move.count = 0; // スキル消費

          const moving = [];
          this.activeGroup.blocks.forEach(b => {
            moving.push({
              fromX: b.x,
              fromY: b.y,
              toX: b.x + dx,
              toY: b.y + dy,
              color: this.board[b.y][b.x].color,
              locked: this.board[b.y][b.x].locked,
              shining: this.board[b.y][b.x].shining,
              revealed: this.board[b.y][b.x].revealed
            });
            this.board[b.y][b.x] = null;
          });

          this.isAnimating = true;

          // Canvasアニメーション情報の設定
          this.currentAnimations = {
            type: 'slide',
            startTime: performance.now(),
            duration: 150, // ms
            blocks: moving
          };
          this.startBoardLoop(); // ループ起動

          setTimeout(() => {
            this.currentAnimations = null;
            this.stopBoardLoop(); // ループ終了

            // データ確定
            moving.forEach(m => {
              this.board[m.toY][m.toX] = {
                color: m.color,
                locked: m.locked,
                shining: m.shining,
                revealed: m.revealed || false,
                revealCount: 0
              };
            });

            // 移動完了したブロックが同色と隣接した場合のアンロック判定
            const newlyMovedCoords = moving.map(m => ({ x: m.toX, y: m.toY }));
            this.updateBlockConnections(); // 接続関係を再計算
            
            const firstBlock = newlyMovedCoords[0];
            const targetColor = this.board[firstBlock.y][firstBlock.x].color;
            const merged = this.checkMergeAndUnlock(newlyMovedCoords, targetColor);
            
            if (merged) {
              const mergedGroup = this.getGroup(firstBlock.x, firstBlock.y);
              if (mergedGroup) {
                for (const b of mergedGroup.blocks) {
                  const block = this.board[b.y][b.x];
                  if (block) {
                    block.locked = false;
                  }
                }
              }
            }

            this.isAnimating = false;
            this.skillActiveMode = null;
            this.activeGroup = null;

            if (this.gameMode === 'GRAVITY') {
              this.triggerGravityShift(() => {
                this.updateBlockConnections();
                this.checkGameOver();
                this.render();
                Sound.playSelect();
              });
            } else {
              this.updateBlockConnections();
              this.checkGameOver();
              this.render();
              Sound.playSelect();
            }
          }, 150);

        } else {
          // 無効な移動の場合は元の位置に戻す
          const moving = this.activeGroup.blocks.map(b => ({
            fromX: b.x + dx,
            fromY: b.y + dy,
            toX: b.x,
            toY: b.y,
            color: this.board[b.y][b.x].color,
            locked: this.board[b.y][b.x].locked,
            shining: this.board[b.y][b.x].shining,
            revealed: this.board[b.y][b.x].revealed
          }));

          this.currentAnimations = {
            type: 'slide',
            startTime: performance.now(),
            duration: 150,
            blocks: moving
          };
          this.startBoardLoop();

          setTimeout(() => {
            this.currentAnimations = null;
            this.stopBoardLoop();
            this.selectGroup(null);
            this.skillActiveMode = null;
            this.render();
          }, 150);

          Sound.playCancel();
        }
        return;
      }

      if (dist < 10 && duration < 350 && this.draggedGrid) {
        const { x, y } = this.draggedGrid;
        const block = this.board[y][x];

        if (block) {
          const clickedGroup = this.getGroup(x, y);

          if (this.skillActiveMode === 'CHANGE') {
            if (this.activeGroup && clickedGroup &&
                this.activeGroup.blocks.some(b => b.x === x && b.y === y)) {
              this.triggerChangeSkill(x, y);
            } else {
              this.selectGroup(clickedGroup);
              this.cursor = { x, y };
              this.updateCursorDOM();
            }
            return;
          }

          if (this.activeGroup && clickedGroup && 
              this.activeGroup.blocks.some(b => b.x === x && b.y === y)) {
            this.clearActiveGroup();
          } else {
            this.selectGroup(clickedGroup);
            this.cursor = { x, y };
            this.updateCursorDOM();
          }
        } else {
          this.selectGroup(null);
          Sound.playCancel();
          this.render();
        }
      }
    };

    let audioActivated = false;
    const activateAudio = () => {
      Sound.init();
      Sound.resume();
      if (!audioActivated) {
        audioActivated = true;
      }
      if (Sound.bgmEnabled && !Sound.bgmPlaying) {
        Sound.playBgm();
      }
    };
    window.addEventListener('pointerdown', () => activateAudio(), { once: false, passive: true });
    window.addEventListener('touchstart', () => activateAudio(), { once: false, passive: true });
    window.addEventListener('click', () => activateAudio(), { once: false, passive: true });

    // 【最適化】touchcancel（OSジェスチャーや通知等による強制中断）や画面遷移時に
    // dragActive/dragOffset がクリアされず stopBoardLoop() も呼ばれないまま、
    // loopBoard() の requestAnimationFrame がアイドル状態でも回り続けてしまう
    // 経路が存在したため、確実にドラッグ状態を後始末する。
    const onDragCancel = () => {
      if (!this.dragActive) return;
      this.dragActive = false;
      this.dragOffset = null;
      this.stopBoardLoop();
      this.render();
    };

    boardEl.addEventListener('touchstart', (e) => {
      // モバイルブラウザでのマウスエミュレーション（重複トリガーによる1タップ消去）を完全に防ぐ
      e.preventDefault();
      activateAudio();
      onDragStart(e);
    }, { passive: false });
    boardEl.addEventListener('touchmove', onDragMove, { passive: true });
    boardEl.addEventListener('touchend', (e) => {
      e.preventDefault();
      onDragEnd(e);
    });
    boardEl.addEventListener('touchcancel', onDragCancel);
    window.addEventListener('blur', onDragCancel);

    boardEl.addEventListener('mousedown', (e) => {
      activateAudio();
      onDragStart(e);
    });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);

    document.addEventListener('click', (e) => {
      activateAudio();
      const target = e.target;
      if (!target) return;

      if (this.state === 'SETTINGS') {
        // 設定画面状態でのクリックイベントは、settingsList イベントリスナーのみで処理するため、
        // ドキュメント側のリスナー処理を実行せず即リターンします。
        return;
      }

      const menuItem = target.closest('.menu-item');
      if (this.state === 'TITLE') {
        if (menuItem) {
          const text = menuItem.innerText.toUpperCase();
          Sound.playSelect();
          if (text.includes('GAME START') || text.includes('ゲーム開始')) {
            if (this.hasSuspendedGame()) {
              this.showDialog(
                "SUSPENDED DATA FOUND.\nDO YOU WANT TO RESUME?",
                ["RESUME", "RESTART"],
                (idx) => {
                  if (idx === 0) {
                    this.resumeSuspendedGame();
                  } else {
                    this.clearSuspendedGame();
                    this.startNewGame();
                  }
                }
              );
            } else {
              this.startNewGame();
            }
          } else if (text.includes('HOW TO PLAY') || text.includes('遊び方')) {
            this.viewingHelpMode = this.gameMode === 'GRAVITY' ? 'GRAVITY' : (this.gameMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'CLASSIC');
            this.state = 'HELP_VIEW';
            this.render();
          } else if (text.includes('SETTING') || text.includes('設定')) {
            this.settingsTemp = {
              bgm: Sound.bgmEnabled,
              sound: Sound.enabled,
              background: this.backgroundType,
              width: this.width,
              height: this.height
            };
            this.menuIndex = 0;
            this.state = 'SETTINGS';
            this.render();
          } else if (text.includes('RANKING') || text.includes('全国ランキング')) {
            this.viewingRankMode = this.gameMode === 'GRAVITY' ? 'GRAVITY' : (this.gameMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'CLASSIC');
            this.state = 'RANKING_VIEW';
            this.render();
          }
          return;
        } else {
          // タイトルのメニューボタン（.menu-item）以外をタップした場合はすべて盤面リロールを発動
          e.stopPropagation();
          this.reroll();
          return;
        }
      }

      if (this.state === 'HELP_VIEW') {
        e.preventDefault();
        e.stopPropagation();
        Sound.playCancel();
        this.backToTitle(false);
        return;
      }
      if (this.state === 'STATS_VIEW') {
        e.preventDefault();
        e.stopPropagation();
        Sound.playCancel();
        this.state = 'SETTINGS'; // プレイデータ統計画面から戻るときは設定画面に戻る
        this.render();
        return;
      }
      if (this.state === 'RANKING_VIEW') {
        e.preventDefault();
        e.stopPropagation();
        Sound.playCancel();
        this.backToTitle(false);
        return;
      }
    });

    // ランキングタブ切り替えボタンのバインド
    const tabClassic = document.getElementById('rank-tab-classic');
    const tabGravity = document.getElementById('rank-tab-gravity');
    const tabMidnight = document.getElementById('rank-tab-midnight');
    if (tabClassic && tabGravity && tabMidnight) {
      tabClassic.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingRankMode !== 'CLASSIC') {
          this.viewingRankMode = 'CLASSIC';
          Sound.playSelect();
          this.renderRankingList();
        }
      });
      tabGravity.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingRankMode !== 'GRAVITY') {
          this.viewingRankMode = 'GRAVITY';
          Sound.playSelect();
          this.renderRankingList();
        }
      });
      tabMidnight.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingRankMode !== 'MIDNIGHT') {
          this.viewingRankMode = 'MIDNIGHT';
          Sound.playSelect();
          this.renderRankingList();
        }
      });
    }

    // ヘルプタブ切り替えボタンのバインド
    const helpTabClassic = document.getElementById('help-tab-classic');
    const helpTabGravity = document.getElementById('help-tab-gravity');
    const helpTabMidnight = document.getElementById('help-tab-midnight');
    if (helpTabClassic && helpTabGravity && helpTabMidnight) {
      helpTabClassic.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingHelpMode !== 'CLASSIC') {
          this.viewingHelpMode = 'CLASSIC';
          Sound.playSelect();
          this.renderHelpView();
        }
      });
      helpTabGravity.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingHelpMode !== 'GRAVITY') {
          this.viewingHelpMode = 'GRAVITY';
          Sound.playSelect();
          this.renderHelpView();
        }
      });
      helpTabMidnight.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingHelpMode !== 'MIDNIGHT') {
          this.viewingHelpMode = 'MIDNIGHT';
          Sound.playSelect();
          this.renderHelpView();
        }
      });
    }

    // データ集計（STATS）タブ切り替えボタンのバインド
    const statsTabClassic = document.getElementById('stats-tab-classic');
    const statsTabGravity = document.getElementById('stats-tab-gravity');
    const statsTabMidnight = document.getElementById('stats-tab-midnight');
    if (statsTabClassic && statsTabGravity && statsTabMidnight) {
      statsTabClassic.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingStatsMode !== 'CLASSIC') {
          this.viewingStatsMode = 'CLASSIC';
          Sound.playSelect();
          this.render(); // render 内の STATS_VIEW 描画処理が再評価される
        }
      });
      statsTabGravity.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingStatsMode !== 'GRAVITY') {
          this.viewingStatsMode = 'GRAVITY';
          Sound.playSelect();
          this.render();
        }
      });
      statsTabMidnight.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewingStatsMode !== 'MIDNIGHT') {
          this.viewingStatsMode = 'MIDNIGHT';
          Sound.playSelect();
          this.render();
        }
      });
    }

    // スキルボタンクリックイベントのバインド
    const btnUndo = document.getElementById('skill-undo');
    if (btnUndo) {
      btnUndo.addEventListener('click', (e) => {
        e.stopPropagation();
        this.triggerUndo();
      });
    }

    const btnMove = document.getElementById('skill-move');
    if (btnMove) {
      btnMove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSkillMode('MOVE');
      });
    }

    const btnChange = document.getElementById('skill-change');
    if (btnChange) {
      btnChange.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSkillMode('CHANGE');
      });
    }

    // メニューボタンのタップイベント
    const menuBtn = document.getElementById('menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        Sound.playSelect();
        this.showPauseMenu();
      });
    }

    const settingsList = document.querySelector('.settings-list');
    if (settingsList) {
      settingsList.addEventListener('click', (e) => {
        const item = e.target.closest('.setting-row') || e.target.closest('.menu-item');
        if (!item) return;

        e.preventDefault();
        e.stopPropagation();

        const text = item.innerText.toUpperCase();
        console.log("Settings item clicked:", text); // デバッグ用ログ
        if (text.includes('BGM')) {
          this.settingsTemp.bgm = !this.settingsTemp.bgm;
          Sound.setBgmEnabled(this.settingsTemp.bgm);
          Sound.playSelect();
          this.render();
        } else if (text.includes('SOUND') || text.includes('SE') || text.includes('音量') || text.includes('音')) {
          this.settingsTemp.sound = !this.settingsTemp.sound;
          Sound.playSelect();
          this.render();
        } else if (text.includes('THEME') || text.includes('背景デザイン')) {
          this.settingsTemp.background = this.settingsTemp.background === 'city' ? 'normal' : 'city';
          Sound.playSelect();
          this.render();
        } else if (text.includes('PLAY STATS') || text.includes('プレイデータ集計')) {
          Sound.playSelect();
          this.state = 'STATS_VIEW';
          this.render();
        } else if (text.includes('RESET BEST') || text.includes('履歴・ベスト消去')) {
          Sound.playSelect();
          this.showDialog(
            "RESET ALL YOUR BEST SCORES?",
            ["NO", "YES"],
            (choice) => {
              if (choice === 1) {
                localStorage.removeItem('my_best_score_record');
                localStorage.removeItem('my_best_score_record_gravity');
                localStorage.removeItem('my_best_score_record_midnight');
                localStorage.removeItem('imode_puzzle_my_history');
                localStorage.removeItem('imode_puzzle_my_history_gravity');
                localStorage.removeItem('imode_puzzle_my_history_midnight');
                localStorage.removeItem('block_slider_remove_ads');
                this.bestScore = 0;
                this.render();
                Sound.playCancel();
                this.showDialog("BEST SCORES RESET.", ["CLOSE"], null);
              }
            }
          );
        } else if (text.includes('SAVE') || text.includes('設定保存') || text.includes('戻る')) {
          Sound.playSelect();
          const nameInput = document.getElementById('player-name-input');
          if (nameInput) {
            this.playerName = nameInput.value.trim() || 'プレイヤー';
            localStorage.setItem('imode_puzzle_player_name', this.playerName);
          }
          Sound.setBgmEnabled(this.settingsTemp.bgm);
          Sound.enabled = this.settingsTemp.sound;
          this.soundEnabled = Sound.enabled;
          this.bgmEnabled = Sound.bgmEnabled;

          this.backgroundType = this.settingsTemp.background;
          localStorage.setItem('imode_puzzle_background', this.backgroundType);
          this.applyBackground(this.backgroundType);

          this.width = 16;
          this.height = 22;

          this.backToTitle(false); // 設定保存して戻るときは盤面リロールを行わない
        }
      });
    }
  },

  saveLocalBest() {
    if (this.score <= 0) return;

    try {
      const currentBest = Ranking.getMyBest();
      if (!currentBest || this.score > currentBest.score) {
        const now = new Date();
        const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        localStorage.setItem(Ranking.getMyBestStorageKey(), JSON.stringify({
          score: this.score,
          date: dateStr
        }));
        this.bestScore = this.score;
      }
    } catch (e) {
      console.error(e);
    }
  },

  submitScore() {
    if (this.score <= 0) {
      this.backToTitle(true);
      return;
    }

    const rank = Ranking.add(this.playerName, this.score);
    this.newRank = rank;
    this.rankingMode = 'ALL';
    this.viewingRankMode = this.gameMode === 'GRAVITY' ? 'GRAVITY' : (this.gameMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'CLASSIC');
    this.state = 'RANKING_VIEW';
    this.render();
  },

  render() {
    const scoreEl = document.getElementById('info-score');
    const comboEl = document.getElementById('info-combo');
    const bestEl = document.getElementById('info-best');
    
    if (scoreEl) scoreEl.innerText = this.score.toLocaleString();
    if (comboEl) {
      const prevCombo = parseInt(comboEl.innerText) || 0;
      comboEl.innerText = this.combo.toLocaleString();
      if (this.combo > prevCombo && this.combo > 0) {
        comboEl.classList.remove('combo-bump', 'combo-bump-mega');
        void comboEl.offsetWidth; // リフロー強制でアニメーション再起動
        if (this.combo >= 100) {
          comboEl.classList.add('combo-bump-mega');
        } else {
          comboEl.classList.add('combo-bump');
        }
      }
    }
    if (bestEl) bestEl.innerText = this.bestScore.toLocaleString();

    const menuOverlay = document.getElementById('menu-overlay');
    const titleSec = document.getElementById('menu-title-sec');
    const settingsSec = document.getElementById('menu-settings-sec');
    const boardRankingOverlay = document.getElementById('board-ranking-overlay');
    const boardGameOverOverlay = document.getElementById('board-gameover-overlay');
    const boardStatsOverlay = document.getElementById('board-stats-overlay');
    const boardHelpOverlay = document.getElementById('board-help-overlay');
    const skillSpace = document.getElementById('skill-space-wrapper');
    const adBanner = document.getElementById('sp-banner-space');
    const gameContainer = document.getElementById('game-container');

    if (menuOverlay) menuOverlay.style.display = 'none';
    if (titleSec) titleSec.style.display = 'none';
    if (settingsSec) settingsSec.style.display = 'none';
    if (boardRankingOverlay) boardRankingOverlay.style.display = 'none';
    if (boardGameOverOverlay) boardGameOverOverlay.style.display = 'none';
    if (boardStatsOverlay) boardStatsOverlay.style.display = 'none';
    if (boardHelpOverlay) boardHelpOverlay.style.display = 'none';
    // 広告削除（課金）のフラグをローカルストレージなどから確認
    const isAdRemoved = localStorage.getItem('block_slider_remove_ads') === 'true';

    // 広告表示制御（課金で広告削除されていない場合は、常に表示し続ける）
    if (adBanner) {
      adBanner.style.display = isAdRemoved ? 'none' : 'flex';

      // 【計測用】GPU負荷切り分けのため、ファイル先頭の DEBUG_AD_ANIMATION 定数で
      // レイアウト・サイズは変えずに広告サンプルのアニメーションだけをON/OFFする。
      adBanner.classList.toggle('sp-anim-off', !DEBUG_AD_ANIMATION);
    }

    // タイトル時の背景盤面半透明化の制御
    if (gameContainer) {
      if (this.state === 'TITLE') {
        gameContainer.classList.add('state-title');
      } else {
        gameContainer.classList.remove('state-title');
      }
    }

    // 上部スコア表示エリア (info-header) の表示・非表示制御 (PLAYING 以外は非表示)
    const infoHeader = document.getElementById('info-header');
    if (infoHeader) {
      if (this.state === 'PLAYING') {
        infoHeader.style.display = 'flex';
      } else {
        infoHeader.style.display = 'none';
      }
    }

    // 重力インジケータ (gravity-hud) の表示・非表示制御
    const gravityHud = document.getElementById('gravity-hud');
    if (gravityHud) {
      if (this.state === 'PLAYING' && this.gameMode === 'GRAVITY') {
        gravityHud.style.display = 'flex';
        const gravityDirEl = document.getElementById('gravity-hud-dir');
        if (gravityDirEl && this.nextGravityDirection) {
          gravityDirEl.innerText = this.nextGravityDirection.icon;
        }
      } else {
        gravityHud.style.display = 'none';
      }
    }

    this.updateCursorDOM();

    // スキルボタン表示と残数・選択状態の更新
    if (skillSpace) {
      if (this.state === 'PLAYING') {
        skillSpace.style.display = 'flex';
        
        // Undoボタンの表示更新
        const btnUndo = document.getElementById('skill-undo');
        if (btnUndo) {
          const isMidnight = (this.gameMode === 'MIDNIGHT');
          btnUndo.disabled = (this.skills.undo.count <= 0 || !this.undoHistory || isMidnight);
          btnUndo.classList.toggle('disabled', isMidnight);
        }

        // Moveボタンの表示更新
        const btnMove = document.getElementById('skill-move');
        if (btnMove) {
          const isMidnight = (this.gameMode === 'MIDNIGHT');
          btnMove.disabled = (this.skills.move.count <= 0 || isMidnight);
          btnMove.classList.toggle('disabled', isMidnight);
          btnMove.classList.toggle('active-skill-mode', this.skillActiveMode === 'MOVE');
        }

        // Changeボタンの表示更新
        const btnChange = document.getElementById('skill-change');
        if (btnChange) {
          const isMidnight = (this.gameMode === 'MIDNIGHT');
          btnChange.disabled = (this.skills.change.count <= 0 || isMidnight);
          btnChange.classList.toggle('disabled', isMidnight);
          btnChange.classList.toggle('active-skill-mode', this.skillActiveMode === 'CHANGE');
        }
      } else {
        skillSpace.style.display = 'none';
      }
    }

    if (this.state === 'TITLE') {
      if (menuOverlay) menuOverlay.style.display = 'flex';
      if (titleSec) {
        titleSec.style.display = 'block';
        const items = titleSec.querySelectorAll('.menu-item');
        items.forEach((item, idx) => {
          if (idx === this.menuIndex) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });
      }
    }
    
    else if (this.state === 'SETTINGS') {
      if (menuOverlay) menuOverlay.style.display = 'flex';
      if (settingsSec) {
        settingsSec.style.display = 'block';
        const bgmVal = document.getElementById('setting-bgm-val');
        if (bgmVal) bgmVal.innerText = this.settingsTemp.bgm ? 'ON' : 'OFF';

        const soundVal = document.getElementById('setting-sound-val');
        if (soundVal) soundVal.innerText = this.settingsTemp.sound ? 'ON' : 'OFF';

        const bgVal = document.getElementById('setting-bg-val');
        if (bgVal) bgVal.innerText = this.settingsTemp.background === 'city' ? 'CYBERPUNK' : 'DEFAULT';

        const items = settingsSec.querySelectorAll('.menu-item');
        items.forEach((item, idx) => {
          if (idx === this.menuIndex) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });
      }
    }

    else if (this.state === 'STATS_VIEW') {
      if (boardStatsOverlay) {
        boardStatsOverlay.style.display = 'flex';
        
        // ヘッダーにモード名を反映
        const headerEl = boardStatsOverlay.querySelector('.stats-header-large');
        const modeName = this.viewingStatsMode === 'GRAVITY' ? 'GRAVITY' : (this.viewingStatsMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'STANDARD');
        if (headerEl) {
          headerEl.innerText = `STATS (${modeName})`;
        }

        // タブボタンのアクティブクラスの同期
        const tabClassic = document.getElementById('stats-tab-classic');
        const tabGravity = document.getElementById('stats-tab-gravity');
        const tabMidnight = document.getElementById('stats-tab-midnight');
        if (tabClassic && tabGravity && tabMidnight) {
          tabClassic.classList.remove('active');
          tabGravity.classList.remove('active');
          tabMidnight.classList.remove('active');

          if (this.viewingStatsMode === 'GRAVITY') {
            tabGravity.classList.add('active');
          } else if (this.viewingStatsMode === 'MIDNIGHT') {
            tabMidnight.classList.add('active');
          } else {
            tabClassic.classList.add('active');
          }
        }

        // ミッドナイトモード選択時は背景色を少し明るく調整して黒ブロックを見えやすくする
        const boardEl = document.getElementById('board');
        if (boardEl) {
          if (this.viewingStatsMode === 'MIDNIGHT') {
            boardEl.classList.add('board-midnight-bg');
          } else {
            boardEl.classList.remove('board-midnight-bg');
          }
        }

        const stats = Stats.get();
        document.getElementById('stats-games-played').innerText = stats.gamesPlayed.toLocaleString();
        document.getElementById('stats-total-cleared').innerText = stats.totalBlocksCleared.toLocaleString();
        document.getElementById('stats-max-single').innerText = stats.maxBlocksSingleClear.toLocaleString();
        document.getElementById('stats-max-combo').innerText = stats.maxCombo.toLocaleString();
      }
    }

    else if (this.state === 'HELP_VIEW') {
      if (boardHelpOverlay) {
        boardHelpOverlay.style.display = 'flex';
        this.renderHelpView();
      }
    }

    else if (this.state === 'GAME_OVER') {
      if (boardGameOverOverlay) {
        boardGameOverOverlay.style.display = 'flex';
        
        const goScore = document.getElementById('board-gameover-score');
        if (goScore) goScore.innerText = this.score.toLocaleString();

        const goChoices = document.getElementById('board-gameover-choices');
        if (goChoices) {
          goChoices.innerHTML = '';
          
          const choices = this.score > 0 ? ['RETURN to TITLE', 'SUBMIT SCORE'] : ['RETURN to TITLE'];
          
          choices.forEach((choice, idx) => {
            const el = document.createElement('div');
            el.className = 'menu-item';
            if (idx === this.menuIndex) el.classList.add('active');
            el.innerText = choice;
            
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              if (idx === 0) {
                Sound.playCancel();
                this.backToTitle(true);
              } else if (idx === 1 && this.score > 0) {
                Sound.playSelect();
                this.submitScore();
              }
            });

            goChoices.appendChild(el);
          });
        }
      }
    }

    else if (this.state === 'RANKING_VIEW') {
      if (boardRankingOverlay) {
        boardRankingOverlay.style.display = 'flex';
        this.renderRankingList();
      }
    }

    // レンダリング直後、DOMサイズ決定後のタイミングで盤面サイズをコンテナ内に縮小収めする
    requestAnimationFrame(() => {
      this.adjustBoardSize();
    });
  },

  renderHelpView() {
    const helpTabClassic = document.getElementById('help-tab-classic');
    const helpTabGravity = document.getElementById('help-tab-gravity');
    const helpTabMidnight = document.getElementById('help-tab-midnight');
    const contentClassic = document.getElementById('help-content-classic');
    const contentGravity = document.getElementById('help-content-gravity');
    const contentMidnight = document.getElementById('help-content-midnight');
    
    // クラス・表示の初期化
    if (helpTabClassic) helpTabClassic.classList.remove('active');
    if (helpTabGravity) helpTabGravity.classList.remove('active');
    if (helpTabMidnight) helpTabMidnight.classList.remove('active');
    if (contentClassic) contentClassic.style.display = 'none';
    if (contentGravity) contentGravity.style.display = 'none';
    if (contentMidnight) contentMidnight.style.display = 'none';

    if (this.viewingHelpMode === 'GRAVITY') {
      if (helpTabGravity) helpTabGravity.classList.add('active');
      if (contentGravity) contentGravity.style.display = 'block';
    } else if (this.viewingHelpMode === 'MIDNIGHT') {
      if (helpTabMidnight) helpTabMidnight.classList.add('active');
      if (contentMidnight) contentMidnight.style.display = 'block';
    } else {
      if (helpTabClassic) helpTabClassic.classList.add('active');
      if (contentClassic) contentClassic.style.display = 'block';
    }
  },

  updateBoardState() {
    this.updateBlockConnections();
    this.renderBoard();
  },

  // 盤面Canvas描画処理の実装
  renderBoard() {
    if (!this.boardCanvas || !this.boardCtx) return;

    const ctx = this.boardCtx;
    const canvas = this.boardCanvas;
    
    // 【最適化】adjustCanvasSize と同じ上限2.0を適用し、canvas.width/height の実寸と整合させる
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const boardWidth = canvas.clientWidth || (canvas.width / dpr);
    const boardHeight = canvas.clientHeight || (canvas.height / dpr);

    // 主要なコンテキストステートの初期化（汚染対策）
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    if (ctx.filter) ctx.filter = 'none';

    // 画面クリア
    ctx.clearRect(0, 0, boardWidth, boardHeight);

    const cellWidth = boardWidth / this.width;
    const cellHeight = boardHeight / this.height;

    // アニメーション進捗の計算
    let t = 1;
    let anim = this.currentAnimations;
    if (anim) {
      const elapsed = performance.now() - anim.startTime;
      t = Math.min(1, elapsed / anim.duration);
      // イーズアウト
      t = 1 - Math.pow(1 - t, 3);
    }

    // 移動中のブロックの座標セットを作成（通常描画から除外するため）
    // anim が存在する間は t>=1 でも fromX,fromY を除外し続ける（setTimeout 発火前の「戻り」を防止）
    this.animatingCoords.clear();
    if (anim) {
      if (anim.type === 'slide') {
        for (let i = 0; i < anim.blocks.length; i++) {
          this.animatingCoords.add(`${anim.blocks[i].fromX},${anim.blocks[i].fromY}`);
        }
      } else if (anim.type === 'gravity') {
        for (let i = 0; i < anim.moves.length; i++) {
          this.animatingCoords.add(`${anim.moves[i].fromX},${anim.moves[i].fromY}`);
        }
      } else if (anim.type === 'appear') {
        for (let i = 0; i < anim.blocks.length; i++) {
          this.animatingCoords.add(`${anim.blocks[i].x},${anim.blocks[i].y}`);
        }
      }
    }

    // activeGroup の座標 Set と shining フラグを1フレームに1回だけ構築（drawSingleCellAtPixel 内の O(n) some() を O(1) に削減）
    if (this.activeGroup) {
      if (!this._activeGroupSet) this._activeGroupSet = new Set();
      else this._activeGroupSet.clear();
      const agBlocks = this.activeGroup.blocks;
      let agShining = false;
      for (let i = 0; i < agBlocks.length; i++) {
        this._activeGroupSet.add(`${agBlocks[i].x},${agBlocks[i].y}`);
        const agCell = this.board[agBlocks[i].y] && this.board[agBlocks[i].y][agBlocks[i].x];
        if (agCell && agCell.shining) agShining = true;
      }
      this._activeGroupShining = agShining;
    } else {
      this._activeGroupSet = null;
      this._activeGroupShining = false;
    }

    let drawCellCount = 0;

    // 1. 静止ブロックの描画
    // 【最適化】アニメーション中、および MOVE スキルのドラッグ中（loopBoard が
    // 継続的に回り続けるが盤面内容自体は変化しない区間）は毎フレーム同一のセル集合が
    // 変化しないため、光る演出（time依存）を除く静止セルをオフスクリーンキャンバスに
    // キャッシュし、セッション開始時のみ再構築する。以後の各フレームは drawImage 1回で合成する。
    const useStaticCache = anim || this.dragOffset;
    if (useStaticCache) {
      const cacheKey = anim || this._dragSessionId;
      const cacheStale = this._staticCacheAnim !== cacheKey
        || !this.staticLayerCanvas
        || this.staticLayerCanvas.width !== canvas.width
        || this.staticLayerCanvas.height !== canvas.height;

      if (cacheStale) {
        if (!this.staticLayerCanvas) {
          this.staticLayerCanvas = document.createElement('canvas');
          this.staticLayerCtx = this.staticLayerCanvas.getContext('2d');
        }
        if (this.staticLayerCanvas.width !== canvas.width || this.staticLayerCanvas.height !== canvas.height) {
          this.staticLayerCanvas.width = canvas.width;
          this.staticLayerCanvas.height = canvas.height;
        }
        const sctx = this.staticLayerCtx;
        sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sctx.clearRect(0, 0, boardWidth, boardHeight);

        this._staticCacheDynamicCells = [];

        for (let y = 0; y < this.height; y++) {
          if (!this.board[y]) continue;
          for (let x = 0; x < this.width; x++) {
            if (this.animatingCoords.has(`${x},${y}`)) continue;
            const cell = this.board[y][x];
            if (!cell) continue;

            const inActiveGroup = this._activeGroupSet && this._activeGroupSet.has(`${x},${y}`);
            // 【修正】MOVEスキルでドラッグ中は、選択グループのセルを指の動きに追従させて
            // 毎フレーム描画し直す必要があるため、静止キャッシュ対象から除外する。
            const isDraggingThisCell = inActiveGroup && !!this.dragOffset;
            const isDynamic = cell.shining || (inActiveGroup && this._activeGroupShining) || isDraggingThisCell;

            if (isDynamic) {
              this._staticCacheDynamicCells.push({ x, y, cell, drag: isDraggingThisCell });
            } else {
              // 【最適化】clip()を含む描画を毎セル実行せず、タイルキャッシュ+drawImageで代替
              this.drawSingleCellViaTile(sctx, x, y, cell, cellWidth, cellHeight, dpr);
            }
          }
        }
        this._staticCacheAnim = cacheKey;
      }

      // キャッシュ済みレイヤーをピクセルコピーのみで合成（Path2D の再描画を回避）
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.staticLayerCanvas, 0, 0);
      ctx.restore();

      // 光る演出など time 依存で見た目が変化するセル、およびドラッグ追従中のセルを毎フレーム個別描画
      for (let i = 0; i < this._staticCacheDynamicCells.length; i++) {
        const d = this._staticCacheDynamicCells[i];
        if (d.drag && this.dragOffset) {
          // 指の移動量ぶんだけオフセットした位置に描画する（本来の盤面座標は
          // gridX/gridY として明示的に渡し、選択中グループの白枠判定を維持する）
          const px = d.x * cellWidth + this.dragOffset.x;
          const py = d.y * cellHeight + this.dragOffset.y;
          this.drawSingleCellAtPixel(ctx, px, py, d.cell, cellWidth, cellHeight, d.x, d.y);
        } else {
          this.drawSingleCell(ctx, d.x, d.y, d.cell, cellWidth, cellHeight);
        }
      }
      // デバッグHUDの表示値（CELLS）は従来と同じ「実質描画対象セル数」を維持
      drawCellCount += (this.width * this.height) - this.animatingCoords.size;
    } else {
      // アニメーション非実行時の単発描画は従来通り（呼び出し頻度が低く最適化不要）
      for (let y = 0; y < this.height; y++) {
        if (!this.board[y]) continue;
        for (let x = 0; x < this.width; x++) {
          if (this.animatingCoords.has(`${x},${y}`)) continue;

          const cell = this.board[y][x];
          if (cell) {
            drawCellCount++;
            this.drawSingleCell(ctx, x, y, cell, cellWidth, cellHeight);
          }
        }
      }
    }

    // 2. 移動中ブロックの描画（anim が存在する間は常に描画、t>=1 では最終位置に固定）
    if (anim) {
      if (anim.type === 'slide') {
        for (let i = 0; i < anim.blocks.length; i++) {
          const b = anim.blocks[i];
          drawCellCount++;
          const curX = b.fromX + (b.toX - b.fromX) * t;
          const curY = b.fromY + (b.toY - b.fromY) * t;
          this.drawSingleCellAtPixel(ctx, curX * cellWidth, curY * cellHeight, b, cellWidth, cellHeight);
        }
      } else if (anim.type === 'gravity') {
        for (let i = 0; i < anim.moves.length; i++) {
          const m = anim.moves[i];
          drawCellCount++;
          const curX = m.fromX + (m.toX - m.fromX) * t;
          const curY = m.fromY + (m.toY - m.fromY) * t;
          this.drawSingleCellAtPixel(ctx, curX * cellWidth, curY * cellHeight, m, cellWidth, cellHeight);
        }
      } else if (anim.type === 'appear') {
        const drawAlpha = Math.min(1, t);
        for (let i = 0; i < anim.blocks.length; i++) {
          const b = anim.blocks[i];
          drawCellCount++;
          ctx.save();
          ctx.globalAlpha = drawAlpha;
          const scale = 0.3 + 0.7 * drawAlpha;
          const w = cellWidth * scale;
          const h = cellHeight * scale;
          const cx = b.x * cellWidth + cellWidth / 2;
          const cy = b.y * cellHeight + cellHeight / 2;
          const px = cx - w / 2;
          const py = cy - h / 2;
          this.drawSingleCellAtPixel(ctx, px, py, b, w, h);
          ctx.restore();
        }
      }
    }

    // 3. キーボードカーソルの描画
    if (this.inputMode !== 'MOUSE') {
      const cx = this.cursor.x;
      const cy = this.cursor.y;
      const block = this.board[cy][cx];
      
      ctx.save();
      const blinkAlpha = 0.5 + 0.5 * (Math.sin(performance.now() * 0.01) * 0.5 + 0.5);
      ctx.globalAlpha = blinkAlpha;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';

      if (block) {
        ctx.strokeRect(cx * cellWidth + 1, cy * cellHeight + 1, cellWidth - 2, cellHeight - 2);
      } else {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.strokeRect(cx * cellWidth + 1, cy * cellHeight + 1, cellWidth - 2, cellHeight - 2);
      }
      ctx.restore();
    }

    // 4. デバッグ情報の描画（DEBUG_STATS=falseの場合は非表示。コードは残したまま描画のみスキップする）
    if (DEBUG_STATS) {
      const now = performance.now();
      this.updateFPS(now);

      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(4, 4, 150, 68);
      ctx.fillStyle = '#00ffcc';
      ctx.font = '10px monospace';
      ctx.fillText(`FPS: ${this.fps}`, 10, 16);
      ctx.fillText(`CELLS: ${drawCellCount}`, 10, 28);
      ctx.fillText(`ANIM: ${anim ? anim.type.toUpperCase() : 'NONE'}`, 10, 40);
      ctx.fillText(`SIZE: ${boardWidth}x${boardHeight} (DPR:${dpr.toFixed(1)})`, 10, 52);
      ctx.fillText(`PHYS: ${canvas.width}x${canvas.height}`, 10, 64);
      ctx.restore();
    }
  },

  updateFPS(now) {
    if (!this.lastFpsTime) {
      this.lastFpsTime = now;
      this.fpsCount = 0;
      this.fps = 60;
      return;
    }
    this.fpsCount++;
    const delta = now - this.lastFpsTime;
    if (delta >= 1000) {
      this.fps = Math.round((this.fpsCount * 1000) / delta);
      this.fpsCount = 0;
      this.lastFpsTime = now;
    }
  },

  // 【最適化】静止セル（isActiveGroup=false かつ shining=false）は
  // (pathKey, colorKey, locked) の組み合わせだけで見た目が一意に決まるため、
  // 初回のみ ctx.clip() を含む描画を行いオフスクリーンタイルとしてキャッシュし、
  // 以降は GPU 負荷の低い drawImage で使い回すことで clip() の呼び出し回数を削減する。
  // 描画内容は drawSingleCellAtPixel の「静止セル用」部分と完全に同一のロジックを使用する。
  drawCellTileCore(tctx, pathKey, colorKey, locked, cellWidth, cellHeight) {
    const path = this.pathCache[pathKey];
    if (!path) return;

    const grad = this.gradientCache[colorKey];
    tctx.fillStyle = grad || '#888888';
    tctx.fill(path);

    tctx.save();
    tctx.clip(path);

    tctx.fillStyle = this.highlightGradient || 'rgba(255, 255, 255, 0.2)';
    tctx.fillRect(1, 1, cellWidth - 2, cellHeight * 0.35);

    if (locked && this.lockPattern) {
      tctx.fillStyle = this.lockPattern;
      tctx.fillRect(0, 0, cellWidth, cellHeight);
    }

    tctx.restore();

    tctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    tctx.lineWidth = 1;
    tctx.stroke(path);
  },

  getCellTile(pathKey, colorKey, locked, cellWidth, cellHeight, dpr) {
    const key = `${pathKey}_${colorKey}_${locked ? 1 : 0}`;
    let tile = this.cellTileCache[key];
    if (tile) return tile;

    tile = document.createElement('canvas');
    tile.width = Math.ceil(cellWidth * dpr);
    tile.height = Math.ceil(cellHeight * dpr);
    const tctx = tile.getContext('2d');
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawCellTileCore(tctx, pathKey, colorKey, locked, cellWidth, cellHeight);

    this.cellTileCache[key] = tile;
    return tile;
  },

  // 静止セル（非shining・非選択中）をタイルキャッシュ経由で描画する。
  // isActiveGroup / shining の判定が必要なセルは呼び出し側で除外済みであることが前提。
  drawSingleCellViaTile(ctx, x, y, cell, cellWidth, cellHeight, dpr) {
    const u = cell.connUp ? '1' : '0';
    const d = cell.connDown ? '1' : '0';
    const l = cell.connLeft ? '1' : '0';
    const r_dir = cell.connRight ? '1' : '0';
    const pathKey = `${u}${d}${l}${r_dir}`;

    if (!this.pathCache[pathKey]) return;

    let colorKey = cell.color;
    if (this.gameMode === 'MIDNIGHT' && !cell.revealed) {
      colorKey = 'midnight';
    }

    const tile = this.getCellTile(pathKey, colorKey, !!cell.locked, cellWidth, cellHeight, dpr);
    const px = x * cellWidth;
    const py = y * cellHeight;
    ctx.drawImage(tile, 0, 0, tile.width, tile.height, px, py, cellWidth, cellHeight);
  },

  // 静止セル描画用ヘルパー
  drawSingleCell(ctx, x, y, cell, cellWidth, cellHeight) {
    const px = x * cellWidth;
    const py = y * cellHeight;
    this.drawSingleCellAtPixel(ctx, px, py, cell, cellWidth, cellHeight);
  },

  // 任意ピクセル位置でのセル描画用ヘルパー（アニメーション用・通常用共通）
  // gridX/gridY を明示的に渡した場合は、そのセルの本来の盤面座標として
  // isActiveGroup（選択中グループの白枠・光る演出）の判定に使用する。
  // 省略時は従来通り px/py から座標を逆算する（既存呼び出し箇所の挙動は変更なし）。
  drawSingleCellAtPixel(ctx, px, py, cell, cellWidth, cellHeight, gridX, gridY) {
    ctx.save();
    ctx.translate(px, py);

    const u = cell.connUp ? '1' : '0';
    const d = cell.connDown ? '1' : '0';
    const l = cell.connLeft ? '1' : '0';
    const r_dir = cell.connRight ? '1' : '0';
    const pathKey = `${u}${d}${l}${r_dir}`;

    const path = this.pathCache[pathKey];
    if (!path) {
      ctx.restore();
      return;
    }

    let colorKey = cell.color;
    if (this.gameMode === 'MIDNIGHT' && !cell.revealed) {
      colorKey = 'midnight';
    }
    const grad = this.gradientCache[colorKey];
    ctx.fillStyle = grad || '#888888';
    ctx.fill(path);

    const cellX = (gridX !== undefined && gridX !== null) ? gridX : Math.round(px / cellWidth);
    const cellY = (gridY !== undefined && gridY !== null) ? gridY : Math.round(py / cellHeight);
    const isActiveGroup = this._activeGroupSet && this._activeGroupSet.has(`${cellX},${cellY}`);
    const isShiningGroup = isActiveGroup && this._activeGroupShining;

    // 【案2】光る演出：時間依存(Math.sin/performance.now)を使わず、固定の半透明黄色
    // オーバーレイを同じpathへもう一度fillするだけにする。clip()は追加しない
    // （fill(path)はpath自体の形状に自然に収まるため、clipなしでも既存の見た目と同じ範囲になる）。
    if (cell.shining || isShiningGroup) {
      ctx.fillStyle = 'rgba(255, 224, 102, 0.22)';
      ctx.fill(path);
    } else if (isActiveGroup) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fill(path);
    }

    ctx.save();
    ctx.clip(path);

    ctx.fillStyle = this.highlightGradient || 'rgba(255, 255, 255, 0.2)';
    ctx.fillRect(1, 1, cellWidth - 2, cellHeight * 0.35);

    if (cell.locked && this.lockPattern) {
      ctx.fillStyle = this.lockPattern;
      ctx.fillRect(0, 0, cellWidth, cellHeight);
    }

    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke(path);

    if (isActiveGroup) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = isShiningGroup ? 4 : 3;
      ctx.stroke(path);
    }

    ctx.restore();
  },

  startBoardLoop() {
    if (this.isLoopingBoard) return;
    this.isLoopingBoard = true;
    this.loopBoard();
  },

  stopBoardLoop() {
    if (!this.isLoopingBoard) return;
    this.isLoopingBoard = false;
    if (this.boardAnimationId) {
      cancelAnimationFrame(this.boardAnimationId);
      this.boardAnimationId = null;
    }
  },

  loopBoard() {
    if (!this.isLoopingBoard) return;

    // 【最適化】高リフレッシュレート端末（90/120Hz等）でも60FPS(約16.67ms間隔)を超えて
    // 描画しないよう制限する。requestAnimationFrame自体は毎回呼び続け、
    // 間隔が短い場合は renderBoard() を呼ばずに次フレームへ回す。
    const now = performance.now();
    const elapsed = now - (this._lastBoardFrameTime || 0);
    const FRAME_INTERVAL = 1000 / 60;

    if (elapsed < FRAME_INTERVAL) {
      this.boardAnimationId = requestAnimationFrame(() => this.loopBoard());
      return;
    }
    // 次回基準時刻を更新（余り時間を持ち越し、実効フレームレートが60FPSから
    // ずれて累積しないようにする）
    this._lastBoardFrameTime = now - (elapsed % FRAME_INTERVAL);

    this.renderBoard();
    this.boardAnimationId = requestAnimationFrame(() => this.loopBoard());
  },

  advanceMidnightTurn() {
    if (this.gameMode !== 'MIDNIGHT') return;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.board[y][x];
        if (cell && cell.revealed) {
          cell.revealCount--;
          if (cell.revealCount <= 0) {
            cell.revealed = false;
            cell.revealCount = 0;
          }
        }
      }
    }
    
    // DOM表示を露出状態に同期
    this.updateMidnightVisuals();
  },

  exposeAdjacentSameColorBlocks(startX, startY) {
    const startCell = this.board[startY][startX];
    if (!startCell) return;
    
    const color = startCell.color;
    const queue = [{x: startX, y: startY}];
    const visited = new Set([`${startX},${startY}`]);
    const dirs = [{dx:0, dy:-1}, {dx:0, dy:1}, {dx:-1, dy:0}, {dx:1, dy:0}];
    
    while (queue.length > 0) {
      const curr = queue.shift();
      const cell = this.board[curr.y][curr.x];
      if (cell) {
        cell.revealed = true;
        cell.revealCount = 10;
      }
      
      dirs.forEach(d => {
        const nx = curr.x + d.dx;
        const ny = curr.y + d.dy;
        if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
          const neighbor = this.board[ny][nx];
          if (neighbor && neighbor.color === color && !visited.has(`${nx},${ny}`)) {
            visited.add(`${nx},${ny}`);
            queue.push({x: nx, y: ny});
          }
        }
      });
    }
  },

  // ミッドナイトモード：盤面全セルのDOMクラスをrevealed状態に応じて差分更新
  updateMidnightVisuals() {
    if (this.gameMode !== 'MIDNIGHT') return;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.board[y][x];
        if (!cell || !cell.el) continue;
        
        const el = cell.el;
        // 全色クラスとmidnightクラスを一旦除去
        Object.values(this.colors).forEach(c => el.classList.remove(c.class));
        el.classList.remove('block-midnight');
        
        if (cell.revealed) {
          el.classList.add(this.colors[cell.color].class);
        } else {
          el.classList.add('block-midnight');
        }
      }
    }
  },

  renderRankingList() {
    const listEl = document.getElementById('large-ranking-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    // モード名をタイトルに動的反映
    const headerEl = document.querySelector('.ranking-header-large');
    if (headerEl) {
      const modeName = this.viewingRankMode === 'GRAVITY' ? 'GRAVITY' : (this.viewingRankMode === 'MIDNIGHT' ? 'MIDNIGHT' : 'STANDARD');
      headerEl.innerText = `LEADERBOARD (${modeName}) TOP 9999`;
    }

    // タブボタンのアクティブクラスの同期
    const tabClassic = document.getElementById('rank-tab-classic');
    const tabGravity = document.getElementById('rank-tab-gravity');
    const tabMidnight = document.getElementById('rank-tab-midnight');
    if (tabClassic && tabGravity && tabMidnight) {
      tabClassic.classList.remove('active');
      tabGravity.classList.remove('active');
      tabMidnight.classList.remove('active');
      
      if (this.viewingRankMode === 'GRAVITY') {
        tabGravity.classList.add('active');
      } else if (this.viewingRankMode === 'MIDNIGHT') {
        tabMidnight.classList.add('active');
      } else {
        tabClassic.classList.add('active');
      }
    }

    const list = Ranking.get();
    const myBest = Ranking.getMyBest();

    let displayList = [];
    if (this.rankingMode === 'ALL') {
      displayList = list.slice(0, 100); // DOM描画負荷を下げるためTOP 100に制限
    } else {
      let myHistoryKey = 'imode_puzzle_my_history';
      if (this.viewingRankMode === 'GRAVITY') myHistoryKey = 'imode_puzzle_my_history_gravity';
      else if (this.viewingRankMode === 'MIDNIGHT') myHistoryKey = 'imode_puzzle_my_history_midnight';
      const myHistory = localStorage.getItem(myHistoryKey);
      if (myHistory) {
        try {
          displayList = JSON.parse(myHistory);
        } catch (e) {
          displayList = [];
        }
      }
      if (displayList.length === 0 && myBest) {
        displayList = [{ name: this.playerName, score: myBest.score, date: myBest.date }];
      }
    }

    displayList.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'ranking-row';
      if (this.rankingMode === 'ALL' && item.name === this.playerName && myBest && item.score === myBest.score) {
        row.classList.add('my-score-row');
      }

      const rankStr = `#${idx + 1}`;
      
      row.innerHTML = `
        <span class="r-rank">${rankStr}</span>
        <span class="r-name">${item.name}</span>
        <span class="r-score">${item.score.toLocaleString()}</span>
        <span class="r-date">${item.date}</span>
      `;
      listEl.appendChild(row);
    });

    const myBestRankEl = document.getElementById('my-best-rank');
    const myBestScoreEl = document.getElementById('my-best-score');
    if (myBest && myBest.score > 0) {
      const myRank = Ranking.getTempRank(myBest.score);
      if (myBestRankEl) myBestRankEl.innerText = `#${myRank}`;
      if (myBestScoreEl) myBestScoreEl.innerText = myBest.score.toLocaleString();
    } else {
      if (myBestRankEl) myBestRankEl.innerText = `---`;
      if (myBestScoreEl) myBestScoreEl.innerText = `0`;
    }
  },



  // 1. Undo（一手戻す）スキルの発動
    triggerUndo() {
    if (this.state !== 'PLAYING' || this.isAnimating) return;
    if (this.gameMode === 'MIDNIGHT') return;
    if (this.skills.undo.count <= 0) {
      Sound.playCancel();
      this.showDialog("Undo has already been used!", ["CLOSE"], null);
      return;
    }
    if (!this.undoHistory) {
      Sound.playCancel();
      this.showDialog("No history to Undo!", ["CLOSE"], null);
      return;
    }

    Sound.playSelect();
    this.skills.undo.count = 0;

    const history = this.undoHistory;
    this.score = history.score;
    this.combo = history.combo;
    
    if (history.skills) {
      this.skills.move.count = history.skills.move.count;
      this.skills.change.count = history.skills.change.count;
    }
    
    this.gameMode = history.gameMode || 'NORMAL';
    this.nextGravityDirection = history.nextGravityDirection ? { ...history.nextGravityDirection } : null;
    
    const previousBoardData = history.board;
    this.undoHistory = null;
    this.activeGroup = null;
    this.skillActiveMode = null;
    this.skillSelectedGroup = null;

    if (history.actionType === 'slide' || history.actionType === 'move') {
      const moved = history.actionData.movedBlocks;
      this.isAnimating = true;

      const duration = history.actionType === 'slide' ? 80 : 150;
      this.currentAnimations = {
        type: 'slide',
        startTime: performance.now(),
        duration: duration,
        blocks: moved.map(m => {
          const cell = this.board[m.to.y][m.to.x];
          return {
            fromX: m.to.x,
            fromY: m.to.y,
            toX: m.from.x,
            toY: m.from.y,
            color: cell ? cell.color : 1,
            locked: cell ? cell.locked : false,
            shining: cell ? cell.shining : false,
            revealed: cell ? cell.revealed : false,
            connUp: cell ? cell.connUp : false,
            connDown: cell ? cell.connDown : false,
            connLeft: cell ? cell.connLeft : false,
            connRight: cell ? cell.connRight : false
          };
        })
      };
      this.startBoardLoop();

      setTimeout(() => {
        this.currentAnimations = null;
        this.stopBoardLoop();

        this.board = previousBoardData.map(row => row.map(cell => {
          if (!cell) return null;
          return {
            color: cell.color,
            locked: cell.locked,
            shining: cell.shining,
            revealed: cell.revealed || false,
            revealCount: cell.revealCount || 0
          };
        }));
        this.updateBoardState();
        this.updateBlockConnections();
        this.isAnimating = false;
        this.render();
      }, duration);

    } else if (history.actionType === 'clear') {
      const cleared = history.actionData.clearedBlocks;
      
      this.board = previousBoardData.map(row => row.map(cell => {
        if (!cell) return null;
        return {
          color: cell.color,
          locked: cell.locked,
          shining: cell.shining,
          revealed: cell.revealed || false,
          revealCount: cell.revealCount || 0
        };
      }));

      this.updateBoardState();
      this.isAnimating = true;

      this.currentAnimations = {
        type: 'appear',
        startTime: performance.now(),
        duration: 150,
        blocks: cleared.map(c => ({
          x: c.x,
          y: c.y,
          color: c.color,
          locked: c.locked,
          shining: false,
          revealed: true
        }))
      };
      this.startBoardLoop();

      setTimeout(() => {
        this.currentAnimations = null;
        this.stopBoardLoop();

        this.updateBlockConnections();
        this.isAnimating = false;
        this.render();
      }, 150);

    } else {
      this.board = previousBoardData.map(row => row.map(cell => {
        if (!cell) return null;
        return {
          color: cell.color,
          locked: cell.locked,
          shining: cell.shining,
          revealed: cell.revealed || false,
          revealCount: cell.revealCount || 0
        };
      }));
      this.updateBoardState();
      this.updateBlockConnections();
      this.render();
    }
  },

  // スキル選択モードのオン・オフ切り替え制御
  setSkillMode(mode) {
    if (this.state !== 'PLAYING' || this.isAnimating) return;
    if (this.gameMode === 'MIDNIGHT') return; // ミッドナイトモードは使用不可
    
    // 現在選択中のブロックの選択解除
    this.selectGroup(null);

    if (this.skillActiveMode === mode) {
      // 同じスキルを再タップした場合は解除
      this.skillActiveMode = null;
      this.skillSelectedGroup = null;
      Sound.playCancel();
    } else {
      this.skillActiveMode = mode;
      this.skillSelectedGroup = null;
      Sound.playSelect();
    }
    this.render();
  },



  // 3. Change（ブロック色変え）スキルの実行
  triggerChangeSkill(startX, startY) {
    if (this.skills.change.count <= 0) return;
    
    const group = this.getGroup(startX, startY);
    if (!group) return;

    this.skillSelectedGroup = group;
    const currentGroupColor = group.color; // 1~5の元の色コードを取得

    // 元の色と同じ色を除外したリストを生成する
    // colors は 1:赤, 2:青, 3:緑, 4:黄, 5:紫
    const allColors = [
      { id: 1, name: "RED" },
      { id: 2, name: "BLUE" },
      { id: 3, name: "GREEN" },
      { id: 4, name: "YELLOW" },
      { id: 5, name: "PURPLE" }
    ];
    const availableColorChoices = allColors.filter(c => c.id !== currentGroupColor);
    const dialogOptions = availableColorChoices.map(c => c.name).concat(["CANCEL"]);

    this.showDialog(
      "SELECT COLOR",
      dialogOptions,
      (choice) => {
        // キャンセル判定 (4つ表示される選択肢の次なのでインデックス 4)
        if (choice === 4) {
          Sound.playCancel();
          this.skillSelectedGroup = null;
          this.skillActiveMode = null;
          this.render();
          return;
        }

        // 色変更開始（Undo履歴保存、アクションタイプ: change）
        const changedBlocks = this.skillSelectedGroup.blocks.map(b => ({
          x: b.x,
          y: b.y,
          oldColor: this.board[b.y][b.x].color
        }));
        this.backupForUndo('change', { changedBlocks });
        this.skills.change.count = 0; // 使用

        // 除外されたリストのインデックスから、ターゲットのカラーIDを取得
        const targetColor = availableColorChoices[choice].id;
        
        // 色を書き換え
        this.skillSelectedGroup.blocks.forEach(b => {
          const cell = this.board[b.y][b.x];
          if (cell) {
            cell.color = targetColor;
            cell.shining = false; // 色を変えた場合、囲まれ状態は解除されるため shining フラグを解除する
            if (cell.el) {
              // 古いクラスを全削除して新カラーを割り当て
              cell.el.className = 'board-cell';
              cell.el.classList.add(this.colors[targetColor].class);
            }
          }
        });

        // 周囲との結合チェックとブロックのアンロック
        this.updateBlockConnections(); // 接続関係を一度計算
        const merged = this.checkMergeAndUnlock(this.skillSelectedGroup.blocks, targetColor);
        if (merged) {
          const mergedGroup = this.getGroup(this.skillSelectedGroup.blocks[0].x, this.skillSelectedGroup.blocks[0].y);
          if (mergedGroup) {
            for (const b of mergedGroup.blocks) {
              const block = this.board[b.y][b.x];
              if (block) {
                block.locked = false;
              }
            }
          }
        }

        // 最終的な盤面のDOM構築
        this.updateBoardState(); // 一旦DOMを作り直す (el参照が新しくなる)
        
        // 色変更完了に伴い、選択中のアクティブグループ情報を完全にクリア (古い結合情報の残留を防ぐ)
        this.activeGroup = null;
        if (typeof this.selectGroup === 'function') {
          this.selectGroup(null);
        }

        // DOM再構築後に『再度』接続状況を計算して、新しく作られたDOMにクラスを完全に付与する
        this.updateBlockConnections();

        this.skillActiveMode = null;
        this.skillSelectedGroup = null;
 
        if (this.gameMode === 'GRAVITY') {
          this.triggerGravityShift(() => {
            this.updateBlockConnections();
            this.checkGameOver();
            this.render();
            Sound.playClear();
          });
        } else {
          this.updateBlockConnections();
          this.checkGameOver();
          this.render();
          Sound.playClear();
        }
      },
      true,
      currentGroupColor // 元のグループカラーを渡す
    );
  },

  keyboardMoveGroup(dx, dy) {
    if (!this.activeGroup || this.isAnimating) return;

    let valid = true;
    const movingSet = new Set(this.activeGroup.blocks.map(b => `${b.x},${b.y}`));
    for (const b of this.activeGroup.blocks) {
      const nx = b.x + dx;
      const ny = b.y + dy;
      if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) {
        valid = false;
        break;
      }
      const target = this.board[ny][nx];
      if (target && !movingSet.has(`${nx},${ny}`)) {
        valid = false;
        break;
      }
    }

    if (!valid) {
      Sound.playCancel();
      return;
    }

    const moving = [];
    this.activeGroup.blocks.forEach(b => {
      moving.push({
        from: { x: b.x, y: b.y },
        to: { x: b.x + dx, y: b.y + dy },
        data: this.board[b.y][b.x]
      });
      this.board[b.y][b.x] = null;
    });

    moving.forEach(m => {
      this.board[m.to.y][m.to.x] = {
        color: m.data.color,
        locked: m.data.locked,
        shining: m.data.shining, // shining フラグを引き継ぐ
        el: m.data.el
      };
      if (m.data.el) {
        m.data.el.style.left = `${(100 / this.width) * m.to.x}%`;
        m.data.el.style.top = `${(100 / this.height) * m.to.y}%`;
        m.data.el.dataset.x = m.to.x;
        m.data.el.dataset.y = m.to.y;
      }
    });

    this.activeGroup.blocks = moving.map(m => m.to);
    this.cursor.x += dx;
    this.cursor.y += dy;
    this.updateCursorDOM();
    Sound.playCursor();
  },

  // 盤面上のすべてのブロックを指定方向に限界まで一括スライドさせる (結合塊を維持 & ロック固定化 & 衝突ロック伝播)
  triggerGravityShift(callback) {
    if (this.gameMode !== 'GRAVITY' || !this.nextGravityDirection) {
      if (callback) callback();
      return;
    }

    // 重力処理が実際に始まる前に、直前のスライドや消去による最新の盤面状態を画面に描画する
    this.updateBlockConnections();
    this.render();

    // 入力を即座にブロック
    this.isAnimating = true;

    // 重力方向のポップアップを表示
    const popupOverlay = document.getElementById('gravity-popup-overlay');
    const popupDir = document.getElementById('gravity-popup-dir');
    if (popupOverlay && popupDir && this.nextGravityDirection) {
      popupDir.innerText = this.nextGravityDirection.icon;
      popupOverlay.className = 'gravity-popup-visible gravity-popup-active';
    }

    // 0.5秒 (500ms) 待機してから重力移動と感染処理を開始する
    setTimeout(() => {
      // ポップアップを隠す
      if (popupOverlay) {
        popupOverlay.className = 'gravity-popup-hidden';
      }

      const { dx, dy } = this.nextGravityDirection;

      // 1. 全グループを取得
      const allGroups = this.getAllGroups();

      // 2. 移動可能グループ (非ロック) と固定グループ (ロック済み) に分類
      const movableGroups = [];
      const lockedBlocksSet = new Set(); // 衝突判定用に動かないブロックの位置を記録

      // 盤面上の全ロック済みブロックをマーク
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          const cell = this.board[y][x];
          if (cell && cell.locked) {
            lockedBlocksSet.add(`${x},${y}`);
          }
        }
      }

      allGroups.forEach(g => {
        // 塊の中に1枚でもロックブロックがあれば、その塊全体を動かさない (不動)
        const hasLocked = g.blocks.some(b => this.board[b.y][b.x] && this.board[b.y][b.x].locked);
        if (hasLocked) {
          // 不動ブロックをセットに追加
          g.blocks.forEach(b => lockedBlocksSet.add(`${b.x},${b.y}`));
        } else {
          movableGroups.push(g);
        }
      });

      // 3. 1歩ずつの同時落下シミュレーション (複雑なマージ塊の衝突突き抜け・データ破壊を完全に防止)
      const groupStates = movableGroups.map(g => {
        const initialBlocks = g.blocks.map(b => ({ x: b.x, y: b.y, cell: this.board[b.y][b.x] }));
        return {
          group: g,
          initialBlocks,
          steps: 0
        };
      });

      let boardChanged = false;
      let simulate = true;

      while (simulate) {
        let movedAnyThisStep = false;

        for (const state of groupStates) {
          const g = state.group;
          let canMoveOneStep = true;
          const ownCoords = new Set(g.blocks.map(b => `${b.x},${b.y}`));

          for (const b of g.blocks) {
            const nx = b.x + dx;
            const ny = b.y + dy;

            if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) {
              canMoveOneStep = false;
              break;
            }

            const targetCell = this.board[ny][nx];
            if (targetCell !== null && !ownCoords.has(`${nx},${ny}`)) {
              canMoveOneStep = false;
              break;
            }
          }

          if (canMoveOneStep) {
            // 現在の座標から一旦退避
            const datas = g.blocks.map(b => {
              const cell = this.board[b.y][b.x];
              this.board[b.y][b.x] = null;
              return cell;
            });

            // 新しい座標に1歩移動して再配置
            g.blocks.forEach((b, idx) => {
              b.x += dx;
              b.y += dy;
              this.board[b.y][b.x] = datas[idx];
            });

            state.steps++;
            movedAnyThisStep = true;
            boardChanged = true;
          }
        }

        if (!movedAnyThisStep) {
          simulate = false;
        }
      }

      const activeMoves = [];
      if (boardChanged) {
        groupStates.forEach(state => {
          if (state.steps > 0) {
            state.initialBlocks.forEach(ib => {
              const finalX = ib.x + dx * state.steps;
              const finalY = ib.y + dy * state.steps;
              activeMoves.push({
                from: { x: ib.x, y: ib.y },
                to: { x: finalX, y: finalY },
                cell: ib.cell
              });
            });
          }
        });
      }

      if (boardChanged) {
        // DOMアニメーションの代わりに Canvas アニメーションを設定
        const moves = activeMoves.map(m => ({
          fromX: m.from.x,
          fromY: m.from.y,
          toX: m.to.x,
          toY: m.to.y,
          color: m.cell.color,
          locked: m.cell.locked,
          shining: m.cell.shining,
          revealed: m.cell.revealed,
          connUp: m.cell.connUp,
          connDown: m.cell.connDown,
          connLeft: m.cell.connLeft,
          connRight: m.cell.connRight
        }));

        this.currentAnimations = {
          type: 'gravity',
          startTime: performance.now(),
          duration: 150, // ms
          moves: moves
        };
        this.startBoardLoop(); // 描画ループ起動

        setTimeout(() => {
          this.currentAnimations = null;
          this.stopBoardLoop(); // 描画ループ停止

          // 4. 重力移動完了後、「ロック感染」を実行
          // 【根本原因の修正】
          // getAllGroups() は同じ色で隣接するブロックを1グループにまとめる。
          // 重力でブロックAがロック済みブロックBの隣に止まると、A+Bは同一グループに合体する。
          // つまり「ロックブロックに隣接する非ロックグループ」を探す旧ロジックでは検出できない。
          // → 正しくは「ロックブロックと非ロックブロックが混在するグループ」を感染対象にする。
          
          const postShiftGroups = this.getAllGroups();

          // 今ターンに「重力で移動した」座標セット
          const movedCoordsSet = new Set(activeMoves.map(m => `${m.to.x},${m.to.y}`));

          // チェーン感染に備えてループ処理
          let newlyLockedAny = true;
          while (newlyLockedAny) {
            newlyLockedAny = false;

            for (const g of postShiftGroups) {
              // グループ内にロック済みブロックが1つも無ければスキップ
              const hasLockedBlock = g.blocks.some(b => {
                const cell = this.board[b.y][b.x];
                return cell && cell.locked;
              });
              if (!hasLockedBlock) continue;

              // グループ内に非ロックブロックが1つも無ければスキップ（全員すでにロック済み）
              const unlockedBlocks = g.blocks.filter(b => {
                const cell = this.board[b.y][b.x];
                return cell && !cell.locked;
              });
              if (unlockedBlocks.length === 0) continue;

              // 非ロックブロックのうち、今回の重力で「実際に移動した」ものがあるか確認
              // （手動でくっつけた場合は checkMergeAndUnlock が事前に locked=false 化するため対象外）
              const hasGravityMovedBlock = unlockedBlocks.some(b => movedCoordsSet.has(`${b.x},${b.y}`));
              if (!hasGravityMovedBlock) continue;

              // 感染: グループ内の全非ロックブロックをロックする
              unlockedBlocks.forEach(b => {
                const cell = this.board[b.y][b.x];
                if (cell) {
                  cell.locked = true;
                  if (cell.el) cell.el.classList.add('block-locked');
                }
              });
              newlyLockedAny = true; // 連鎖感染に備えて再ループ
            }
          }

          // 新たにロックされたブロックがある場合、DOMの整合性を確保するために再構築する
          this.updateBoardState();

          // 重力方向の再選出
          const randIdx = Math.floor(Math.random() * this.gravityDirections.length);
          this.nextGravityDirection = this.gravityDirections[randIdx];

          this.isAnimating = false;
          if (callback) callback();
        }, 150);

      } else {
        // 盤面に変化がなかった場合でも、重力方向を再選出する
        const randIdx = Math.floor(Math.random() * this.gravityDirections.length);
        this.nextGravityDirection = this.gravityDirections[randIdx];
        this.isAnimating = false;
        if (callback) callback();
      }
    }, 500);
  }
};

window.addEventListener('DOMContentLoaded', () => {
  Game.init();
});
