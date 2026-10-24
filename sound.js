// sound.js - Web Audio APIを使ったレトロ8bitサウンドジェネレーター ＆ BGMループプレイヤー

const Sound = {
  enabled: true,
  ctx: null,

  // BGM関連
  bgmEnabled: true,
  bgmBuffer: null,
  bgmSource: null,
  bgmGainNode: null,
  bgmLoading: false,
  bgmPlaying: false,
  bgmPendingPlay: false,
  bgmVolume: 0.22, // 従来の0.32の70%の音量に調整

  init() {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Safariなどのブラウザで音声のレジュームが必要な場合の対策
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    } catch (e) {
      console.warn("Web Audio API is not supported or blocked in this browser.", e);
    }
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(err => console.warn("Failed to resume AudioContext", err));
    }
  },

  initBgm() {
    const saved = localStorage.getItem('imode_puzzle_bgm_enabled');
    if (saved !== null) {
      this.bgmEnabled = (saved === 'true');
    }
  },

  setBgmEnabled(enabled) {
    this.bgmEnabled = !!enabled;
    localStorage.setItem('imode_puzzle_bgm_enabled', this.bgmEnabled ? 'true' : 'false');
    if (this.bgmEnabled) {
      this.playBgm();
    } else {
      this.stopBgm();
    }
  },

  async loadBgm() {
    if (this.bgmBuffer) return this.bgmBuffer;
    if (this.bgmLoading) return null;
    this.init();
    if (!this.ctx) return null;

    this.bgmLoading = true;
    try {
      const response = await fetch('bgm.mp3');
      const arrayBuffer = await response.arrayBuffer();
      this.bgmBuffer = await new Promise((resolve, reject) => {
        this.ctx.decodeAudioData(arrayBuffer, resolve, reject);
      });
      this.bgmLoading = false;
      if (this.bgmPendingPlay && this.bgmEnabled) {
        this.bgmPendingPlay = false;
        this.playBgm();
      }
      return this.bgmBuffer;
    } catch (e) {
      console.warn("Failed to load or decode BGM:", e);
      this.bgmLoading = false;
      return null;
    }
  },

  async playBgm() {
    if (!this.bgmEnabled) return;
    this.init();
    this.resume();

    if (this.bgmPlaying && this.bgmSource) {
      return;
    }

    if (!this.bgmBuffer) {
      this.bgmPendingPlay = true;
      this.loadBgm();
      return;
    }

    if (!this.ctx) return;

    try {
      if (this.bgmSource) {
        try { this.bgmSource.stop(); } catch(e){}
        this.bgmSource.disconnect();
        this.bgmSource = null;
      }

      const source = this.ctx.createBufferSource();
      source.buffer = this.bgmBuffer;
      source.loop = true; // 完全シームレス（ギャップレス）ループ再生

      if (!this.bgmGainNode) {
        this.bgmGainNode = this.ctx.createGain();
        this.bgmGainNode.connect(this.ctx.destination);
      }

      this.bgmGainNode.gain.setValueAtTime(this.bgmVolume, this.ctx.currentTime);
      source.connect(this.bgmGainNode);
      source.start(0);

      this.bgmSource = source;
      this.bgmPlaying = true;
    } catch (e) {
      console.warn("Error playing BGM:", e);
    }
  },

  stopBgm() {
    this.bgmPendingPlay = false;
    this.bgmPlaying = false;
    if (this.bgmSource) {
      try { this.bgmSource.stop(); } catch(e){}
      try { this.bgmSource.disconnect(); } catch(e){}
      this.bgmSource = null;
    }
  },

  // カーソル移動音 (ピッ)
  playCursor() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      
      osc.type = 'square'; // 8bit風の矩形波
      osc.frequency.setValueAtTime(900, this.ctx.currentTime); // 高めの音
      
      gain.gain.setValueAtTime(0.03, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.04);
      
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      
      osc.start();
      osc.stop(this.ctx.currentTime + 0.04);
    } catch (e) {
      console.error(e);
    }
  },

  // 決定音 / 選択音 (ピピッ)
  playSelect() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      
      const playNote = (freq, start, duration) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.05, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(start);
        osc.stop(start + duration);
      };
      
      playNote(650, now, 0.05);
      playNote(980, now + 0.06, 0.08);
    } catch (e) {
      console.error(e);
    }
  },

  // キャンセル音 (ピョーン/ピュッ)
  playCancel() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      
      osc.type = 'triangle'; // 三角波で少し丸い音
      osc.frequency.setValueAtTime(500, now);
      osc.frequency.linearRampToValueAtTime(250, now + 0.1);
      
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      
      osc.start();
      osc.stop(now + 0.1);
    } catch (e) {
      console.error(e);
    }
  },

  // 消去音 (シュワッ ＋ ピコピコ)
  playClear() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      
      // 1. ノイズによる破裂・消去感の演出
      try {
        const bufferSize = this.ctx.sampleRate * 0.12; // 0.12秒
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;
        
        const noiseFilter = this.ctx.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.setValueAtTime(1200, now);
        noiseFilter.frequency.exponentialRampToValueAtTime(150, now + 0.12);
        
        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.05, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        
        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.ctx.destination);
        noise.start(now);
      } catch (e) {
        console.warn("Noise buffer generation failed, skipping noise SE.", e);
      }
      
      // 2. トーン音（ピロロ）
      const osc = this.ctx.createOscillator();
      const toneGain = this.ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15); // 急上昇
      
      toneGain.gain.setValueAtTime(0.04, now);
      toneGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      
      osc.connect(toneGain);
      toneGain.connect(this.ctx.destination);
      
      osc.start(now);
      osc.stop(now + 0.15);
    } catch (e) {
      console.error(e);
    }
  },

  // コンボ音 (コンボ数に応じた上昇メロディ)
  playCombo(combo) {
    if (!this.enabled) return;
    if (combo < 1) return; // 0以下のコンボは再生しない
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      
      // ペンタトニックスケール (ド レ ミ ソ ラ) をベースに上昇
      const pentatonic = [261.63, 293.66, 329.63, 392.00, 440.00];
      const len = pentatonic.length;
      
      // combo数上限を設定（高音ノイズ防止のため15コンボを最大上限にする）
      const cappedCombo = Math.min(15, combo);
      
      // combo数に応じて周波数を算出
      const noteIndex = (cappedCombo - 1) % len;
      const octave = Math.floor((cappedCombo - 1) / len);
      const baseFreq = pentatonic[noteIndex] * Math.pow(2, octave);
      
      // アルペジオ（和音の分散）で「ピロロン♪」と鳴らす
      const playSubNote = (freq, startOffset, duration) => {
        if (!freq || isNaN(freq) || !isFinite(freq)) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        
        osc.type = 'square';
        // 周波数が nominal range を超えないように 12000Hz でクランプ
        const safeFreq = Math.min(12000, freq);
        osc.frequency.setValueAtTime(safeFreq, now + startOffset);
        
        gain.gain.setValueAtTime(0.04, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
        
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        
        osc.start(now + startOffset);
        osc.stop(now + startOffset + duration);
      };
      
      // 3つの音をずらして鳴らす
      playSubNote(baseFreq, 0, 0.12);
      playSubNote(baseFreq * 1.25, 0.04, 0.12); // 3度
      playSubNote(baseFreq * 1.5, 0.08, 0.16);  // 5度
    } catch (e) {
      console.error(e);
    }
  }
};
