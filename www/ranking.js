// ranking.js - 擬似オンラインランキングシステム

const Ranking = {
  storageKey: 'imode_puzzle_ranking',
  defaultNames: [
    'あゆみ★', 'YOSHIKI', '†黒翼の堕天使†', '☆しょうた☆', 'みく@ドコモ',
    'くみこ♪', 'りょうP', '★MAX_HIRO★', 'ちーちゃん', 'VIPER',
    'ゆきぽよ', 'ケンジ@GREE', '★愛莉★', 'モバゲ中毒', 'D-505iS',
    '†聖夜†', 'あさみ♪', 'タクヤ', 'るなっち', 'N905i_user',
    'ルパン三世', '姫川★麗', '☆Taka☆', 'さゆりん', '悪魔将軍',
    'マイメロちゃん', 'まーくん', '伝説の勇者', 'P903iTV', '涼宮ハルヒ',
    '†KIRA†', 'ゆーすけ', 'さくらこ', 'まおにゃん', 'GacktLOVE',
    'ネオジオン', 'エリザベス', '☆だいき☆', 'ななこ', 'マサト',
    'まどか☆', '流星の絆', 'SH906i', '美咲★', '†漆黒の翼†',
    'ひろちゃん', 'あきら', 'ともみ', 'コナン', '☆ゆうき☆',
    'アリス', '直樹', 'かなっぺ', 'りゅうじ', 'めぐみ',
    'タカシ', 'れいな', 'ヒロキ', 'さやか', 'かずや',
    'ユウコ', 'シュン', 'ちひろ', 'ツバサ', 'あいこ',
    'ダイスケ', 'ゆみこ', 'コウヘイ', 'えりか', 'ヨシオ',
    'なおこ', 'シンジ', 'ともこ', 'ケンタ', 'まりこ',
    'ハヤト', 'まい', 'ユースケ', 'かおり', 'タクマ',
    'あすか', 'ソウタ', 'ちえ', 'リョウタ', 'なつみ',
    'ユウタ', 'みほ', 'ショウタ', 'ゆかり', 'タイチ',
    'みさき', 'コウタ', 'あやか', 'リョウ', 'はるか',
    'ユウト', 'かな', 'タクト', 'えり', 'ヒカル'
  ],

  // 初期NPCデータの生成
  generateDefaultData() {
    const data = [];
    const now = new Date();
    
    for (let i = 0; i < 9999; i++) {
      const name = this.defaultNames[i % this.defaultNames.length];
      
      // 9999位に合わせた段階的なスコア分布
      let score;
      if (i < 10) {
        // TOP 10: 1,000,000,000 〜 10,000,000,000
        score = Math.floor(1000000000 + Math.random() * 9000000000);
      } else if (i < 100) {
        // TOP 100: 100,000,000 〜 1,000,000,000
        score = Math.floor(100000000 + Math.random() * 900000000);
      } else if (i < 1000) {
        // TOP 1000: 10,000,000 〜 100,000,000
        score = Math.floor(10000000 + Math.random() * 90000000);
      } else if (i < 5000) {
        // TOP 5000: 1,000,000 〜 10,000,000
        score = Math.floor(1000000 + Math.random() * 9000000);
      } else {
        // その他: 1,000 〜 1,000,000
        score = Math.floor(1000 + Math.random() * 999000);
      }

      const year = Math.random() > 0.5 ? (2007 + Math.floor(Math.random() * 4)) : now.getFullYear();
      const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
      const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
      const dateStr = `${year}/${month}/${day}`;

      data.push({ name, score, date: dateStr });
    }

    // スコア降順にソート
    data.sort((a, b) => b.score - a.score);
    return data;
  },

  // キーの動的解決 (CLASSIC と GRAVITY, MIDNIGHT でランキングを分離)
  getStorageKey() {
    let mode = 'classic';
    if (typeof Game !== 'undefined') {
      if (Game.state === 'RANKING_VIEW' && Game.viewingRankMode) {
        mode = Game.viewingRankMode.toLowerCase();
      } else {
        mode = (Game.gameMode === 'GRAVITY') ? 'gravity' : ((Game.gameMode === 'MIDNIGHT') ? 'midnight' : 'classic');
      }
    }
    if (mode === 'gravity') return 'imode_puzzle_ranking_gravity';
    if (mode === 'midnight') return 'imode_puzzle_ranking_midnight';
    return 'imode_puzzle_ranking';
  },

  getMyBestStorageKey() {
    let mode = 'classic';
    if (typeof Game !== 'undefined') {
      if (Game.state === 'RANKING_VIEW' && Game.viewingRankMode) {
        mode = Game.viewingRankMode.toLowerCase();
      } else {
        mode = (Game.gameMode === 'GRAVITY') ? 'gravity' : ((Game.gameMode === 'MIDNIGHT') ? 'midnight' : 'classic');
      }
    }
    if (mode === 'gravity') return 'my_best_score_record_gravity';
    if (mode === 'midnight') return 'my_best_score_record_midnight';
    return 'my_best_score_record';
  },

  // ランキング全取得
  get() {
    const key = this.getStorageKey();
    let localData = localStorage.getItem(key);
    if (!localData) {
      const defaultData = this.generateDefaultData();
      localStorage.setItem(key, JSON.stringify(defaultData));
      return defaultData;
    }
    try {
      const parsed = JSON.parse(localData);
      // 古い100件のランキングデータ等を検知したら自動で9999件に拡張アップデート
      if (parsed.length < 500) {
        const defaultData = this.generateDefaultData();
        localStorage.setItem(key, JSON.stringify(defaultData));
        return defaultData;
      }
      return parsed;
    } catch (e) {
      const defaultData = this.generateDefaultData();
      localStorage.setItem(key, JSON.stringify(defaultData));
      return defaultData;
    }
  },

  // スコアの追加（TOP 9999に入るかチェックし、入れば保存）
  // 戻り値: ランクインした場合はその順位 (1〜9999)、圏外なら0
  add(name, score) {
    const list = this.get();
    const cleanName = (name || '名無しさん').substring(0, 10);
    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    
    const newEntry = { name: cleanName, score, date: dateStr };
    list.push(newEntry);
    
    // スコア降順ソート
    list.sort((a, b) => b.score - a.score);
    
    // TOP 9999に絞る
    const top9999 = list.slice(0, 9999);
    
    // 自分がどこに入ったかを検索
    let rank = 0;
    for (let i = 0; i < top9999.length; i++) {
      if (top9999[i].score === score && top9999[i].name === cleanName && top9999[i].date === dateStr) {
        rank = i + 1;
        break;
      }
    }
    
    localStorage.setItem(this.getStorageKey(), JSON.stringify(top9999));
    return rank;
  },

  // スコアの仮順位を取得
  getTempRank(score) {
    const list = this.get();
    let rank = 1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].score > score) {
        rank++;
      } else {
        break;
      }
    }
    return rank;
  },

  // ハイスコア（1位）を取得
  getBestScore() {
    const list = this.get();
    return list.length > 0 ? list[0].score : 0;
  },

  // 自分のハイスコア情報の取得
  getMyBest() {
    const data = localStorage.getItem(this.getMyBestStorageKey());
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  },

  // 自分のハイスコア情報の保存
  setMyBest(rank, score, name) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const record = { rank, score, name, date: dateStr };
    localStorage.setItem(this.getMyBestStorageKey(), JSON.stringify(record));
  },

  // 自分のハイスコアの最新順位を更新
  updateMyBestRank() {
    const currentBest = this.getMyBest();
    if (!currentBest) return;

    const list = this.get();
    let newRank = 0;
    // リストの中から自分のハイスコア以上のスコアの件数を調べて順位を特定
    for (let i = 0; i < list.length; i++) {
      if (list[i].score === currentBest.score && list[i].name === currentBest.name) {
        newRank = i + 1;
        break;
      }
    }
    // もし完全に一致するものが見つからなければ、スコアのしきい値で判定
    if (newRank === 0) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].score <= currentBest.score) {
          newRank = i + 1;
          break;
        }
      }
    }
    
    if (newRank > 0 && newRank !== currentBest.rank) {
      currentBest.rank = newRank;
      localStorage.setItem(this.getMyBestStorageKey(), JSON.stringify(currentBest));
    }
  }
};
