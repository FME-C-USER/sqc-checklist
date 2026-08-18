// ============================================================
// SQC 請款金額計算（純函式，無畫面依賴；瀏覽器與 Node 皆可載入以便驗算）
//   計費基準：已點檢的店（未點檢不計費、不列入客戶明細）
//   假日/遠程：取店鋪名單的店鋪屬性（非實際點檢日）
//   遠程為「加價」：在基本點檢費之上另計一列
//   文件處理費：固定每月一筆，掛在業務部（單價可於「設定」活頁調整）
//   外島交通費：無資料來源，由使用者於產出前手動輸入（依課別）
// ============================================================
(function (root) {
  'use strict';

  var DEFAULT_PRICING = {
    平日點檢費: 245,
    平日遠程加價: 220,
    假日點檢費: 470,
    假日遠程加價: 345,
    文件處理費: 6500,
    稅率: 0.05,
  };

  var DEPT_RANK = { '一部': 1, '二部': 2, '業務部': 3 }; // 其餘依名稱排序附於後
  var DOC_FEE_DEPT = '業務部';                            // 文件處理費歸屬部別
  var DOC_FEE_LABEL = '資料處理';                          // 業務部彙總矩陣中的列名

  var isYes = function (v) { return v === true || v === '是' || v === 'V' || v === 'v' || v === '1'; };

  // 課別排序：中文數字要按數值排（直接字串排序會變成 北一→北三→北二，因為字元編碼順序不是數字順序）
  var CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function sectionSortKey(name) {
    var m = String(name).match(/^(.*?)([一二三四五六七八九十])(課|區|部)?$/);
    return (m && CN_NUM[m[2]]) ? [m[1], CN_NUM[m[2]]] : [String(name), 0];
  }
  function compareSection(a, b) {
    var ka = sectionSortKey(a), kb = sectionSortKey(b);
    if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
    return ka[1] - kb[1];
  }

  /** 依遠程/假日屬性推導計價用的店型態 */
  function storeTypeOf(remote, holiday) {
    var r = isYes(remote), h = isYes(holiday);
    if (h && r) return '假日遠程店';
    if (h) return '假日店';
    if (r) return '平日遠程店';
    return '一般店';
  }

  /** 一群店的計費結果；opts.includeDocFee=是否含文件處理費、opts.offshore=外島交通費金額 */
  function computeGroup(stores, pricing, opts) {
    var p = Object.assign({}, DEFAULT_PRICING, pricing || {});
    var o = opts || {};
    var n = { 平日: 0, 平日遠程: 0, 假日: 0, 假日遠程: 0 };
    stores.forEach(function (s) {
      var r = isYes(s.遠程店), h = isYes(s.假日店);
      if (h) { n.假日++; if (r) n.假日遠程++; }
      else { n.平日++; if (r) n.平日遠程++; }
    });
    var lines = [
      { 群: '平日', 項目: '點檢費', 數量: n.平日, 單價: p.平日點檢費 },
      { 群: '', 項目: '遠程加價', 數量: n.平日遠程, 單價: p.平日遠程加價 },
      { 群: '假日', 項目: '點檢費', 數量: n.假日, 單價: p.假日點檢費 },
      { 群: '', 項目: '遠程加價', 數量: n.假日遠程, 單價: p.假日遠程加價 },
    ];
    if (o.includeOffshore) lines.push({ 群: '外島交通費', 項目: '', 數量: o.offshore ? 1 : 0, 單價: Number(o.offshore) || 0 });
    if (o.includeDocFee) lines.push({ 群: '文件處理費', 項目: '', 數量: 1, 單價: p.文件處理費 });
    lines.forEach(function (l) { l.小計 = l.數量 * l.單價; });

    var 未稅 = lines.reduce(function (a, l) { return a + l.小計; }, 0);
    var 稅金 = Math.round(未稅 * p.稅率);
    return { lines: lines, 家數: stores.length, 未稅: 未稅, 稅金: 稅金, 總計: 未稅 + 稅金, counts: n };
  }

  /** 依部別/課別分組（皆以「主責部/主責課」為準，即盤點責任歸屬，非店鋪的營業部課） */
  function groupStores(stores) {
    var byDept = {}, deptOrder = [];
    stores.forEach(function (s) {
      var d = s.主責部 || '(未分類)', c = s.主責課 || '(未分類)';
      if (!byDept[d]) { byDept[d] = { dept: d, sections: {}, sectionOrder: [], all: [] }; deptOrder.push(d); }
      var g = byDept[d];
      g.all.push(s);
      if (!g.sections[c]) { g.sections[c] = []; g.sectionOrder.push(c); }
      g.sections[c].push(s);
    });
    deptOrder.sort(function (a, b) {
      var ra = DEPT_RANK[a] || 99, rb = DEPT_RANK[b] || 99;
      return ra !== rb ? ra - rb : (a < b ? -1 : 1);
    });
    deptOrder.forEach(function (d) { byDept[d].sectionOrder.sort(compareSection); });
    return { byDept: byDept, deptOrder: deptOrder };
  }

  /** 期間標題文字，如「6月請款明細(6/1-6/30)」 */
  function periodLabel(from, to) {
    var f = String(from || ''), t = String(to || '');
    var mm = f.slice(5, 7).replace(/^0/, '');
    var fd = f.slice(5, 7).replace(/^0/, '') + '/' + f.slice(8, 10).replace(/^0/, '');
    var td = t.slice(5, 7).replace(/^0/, '') + '/' + t.slice(8, 10).replace(/^0/, '');
    return { 月: mm, 區間: fd + '-' + td };
  }

  // ===== 版面：請款總表區塊（項目/數量/單價/小計）=====
  function blockRows(title, g, taxRate) {
    var rows = [];
    if (title) rows.push([title]);
    rows.push(['項目 ', '', '數量', '單價', '小計', '備註']);
    g.lines.forEach(function (l) { rows.push([l.群, l.項目, l.數量, l.單價, l.小計, '']); });
    rows.push(['合計', '', '', '', g.未稅, '']);
    rows.push([Math.round(taxRate * 100) + '%稅金', '', '', '', g.稅金, '']);
    rows.push(['總計', '', '', '', g.總計, '']);
    return rows;
  }

  /**
   * 產生四個分頁的二維陣列
   * @param {Object} report buildMonthlyReport 的回傳（需含 rows）
   * @param {Object} pricing 單價設定（來自「設定」活頁；未設定則用內建預設）
   * @param {Object} offshoreBySection 外島交通費 { 課別: 金額 }（手動輸入）
   * @param {Object} period { from, to } 查詢起訖日
   */
  function buildBillingSheets(report, pricing, offshoreBySection, period) {
    var p = Object.assign({}, DEFAULT_PRICING, pricing || {});
    var off = offshoreBySection || {};
    var lab = periodLabel(period && period.from, period && period.to);
    var head = '#' + lab.月 + '月請款明細(' + lab.區間 + ')';

    // 已點檢的店（計費基準）
    var stores = (report.rows || []).map(function (r) {
      return {
        營業部: r.營業部, 營業課別: r.營業課別, 店號: r.店號, 店名: r.店名, 營業擔當: r.營業擔當,
        主責部: r.主責部, 主責課: r.主責課, 遠程店: r.遠程店, 假日店: r.假日店,
        店型態: storeTypeOf(r.遠程店, r.假日店),
      };
    });
    var grouped = groupStores(stores);
    var totalOffshore = Object.keys(off).reduce(function (a, k) { return a + (Number(off[k]) || 0); }, 0);

    // ---- 分頁1：請款明細(客戶) ----
    var all = computeGroup(stores, p, { includeDocFee: true, includeOffshore: totalOffshore > 0, offshore: totalOffshore });
    var 客戶 = [];
    客戶.push([head + ': ' + lab.月 + '月合計檢測 ' + stores.length + '店。']);
    blockRows(null, all, p.稅率).forEach(function (r) { 客戶.push(r); });
    客戶.push([]); 客戶.push([]);
    客戶.push([lab.月 + '月請SQC點檢店明細表']);
    客戶.push(['NO', '營業部', '營業課別', '店號', '店名', '營業擔當', '店型態', '假日', '遠程', '部別', '課別']);
    stores.forEach(function (s, i) {
      客戶.push([i + 1, s.營業部, s.營業課別, s.店號, s.店名, s.營業擔當, s.店型態,
        isYes(s.假日店) ? 'V' : '', isYes(s.遠程店) ? 'V' : '', s.主責部, s.主責課]);
    });

    // ---- 分頁2：請款明細(內部)：全部合計 + 各部 ----
    var 內部 = [];
    內部.push([head + ': ' + lab.月 + '月合計檢測 ' + stores.length + '店。']);
    blockRows(null, all, p.稅率).forEach(function (r) { 內部.push(r); });
    grouped.deptOrder.forEach(function (d) {
      var g = computeGroup(grouped.byDept[d].all, p, {
        includeDocFee: d === DOC_FEE_DEPT,
        includeOffshore: false,
      });
      內部.push([]); 內部.push([]); 內部.push([]);
      blockRows(head + ':盤點中心' + d, g, p.稅率).forEach(function (r) { 內部.push(r); });
    });

    // ---- 分頁3+：各部的各課明細 ----
    var 各課 = {};
    var mainDepts = grouped.deptOrder.filter(function (d) { return d !== DOC_FEE_DEPT; });
    mainDepts.forEach(function (d, di) {
      var gd = grouped.byDept[d];
      var left = [];
      left.push([head + ':盤點中心' + d]);
      gd.sectionOrder.forEach(function (c, ci) {
        var offAmt = Number(off[c]) || 0;
        var g = computeGroup(gd.sections[c], p, { includeDocFee: false, includeOffshore: true, offshore: offAmt });
        if (ci > 0) { left.push([]); left.push([]); }
        left.push([c]);
        blockRows(null, g, p.稅率).forEach(function (r) { left.push(r); });
      });

      // 右側彙總矩陣
      var deptG = computeGroup(gd.all, p, { includeDocFee: false, includeOffshore: totalOffshoreOf(gd, off) > 0, offshore: totalOffshoreOf(gd, off) });
      var right = [];
      right.push([head + ':盤點中心' + d]);
      right.push(['合計', '', '', deptG.未稅]);
      right.push([Math.round(p.稅率 * 100) + '%稅金', '', '', deptG.稅金]);
      right.push(['總計', '', '', deptG.總計]);
      right.push([]);
      right.push([d, '未稅', Math.round(p.稅率 * 100) + '%', '總計', '家數']);
      var sum = { 未稅: 0, 稅金: 0, 總計: 0, 家數: 0 };
      gd.sectionOrder.forEach(function (c) {
        var g = computeGroup(gd.sections[c], p, { includeDocFee: false, includeOffshore: true, offshore: Number(off[c]) || 0 });
        right.push([c, g.未稅, g.稅金, g.總計, g.家數]);
        sum.未稅 += g.未稅; sum.稅金 += g.稅金; sum.總計 += g.總計; sum.家數 += g.家數;
      });
      right.push(['合計', sum.未稅, sum.稅金, sum.總計, sum.家數]);

      // 第一張各課表右側附掛 業務部 彙總（比照人工版）
      var right2 = [];
      if (di === 0 && grouped.byDept[DOC_FEE_DEPT]) {
        var bd = grouped.byDept[DOC_FEE_DEPT];
        var bdG = computeGroup(bd.all, p, { includeDocFee: true, includeOffshore: false });
        right2.push([head + ':盤點中心' + DOC_FEE_DEPT]);
        right2.push(['合計', '', '', bdG.未稅]);
        right2.push([Math.round(p.稅率 * 100) + '%稅金', '', '', bdG.稅金]);
        right2.push(['總計', '', '', bdG.總計]);
        right2.push([]);
        right2.push([DOC_FEE_DEPT, '家數', '未稅', Math.round(p.稅率 * 100) + '%', '總計']);
        var s2 = { 家數: 0, 未稅: 0, 稅金: 0, 總計: 0 };
        bd.sectionOrder.forEach(function (c) {
          var g = computeGroup(bd.sections[c], p, { includeDocFee: false, includeOffshore: false });
          right2.push([c, g.家數, g.未稅, g.稅金, g.總計]);
          s2.家數 += g.家數; s2.未稅 += g.未稅; s2.稅金 += g.稅金; s2.總計 += g.總計;
        });
        var docNet = p.文件處理費, docTax = Math.round(docNet * p.稅率);
        right2.push([DOC_FEE_LABEL, '', docNet, docTax, docNet + docTax]);
        right2.push(['合計', s2.家數, s2.未稅 + docNet, s2.稅金 + docTax, s2.總計 + docNet + docTax]);
      }

      各課['請款明細(' + d + '各課)'] = mergeSideBySide(left, right, right2);
    });

    return { 客戶: 客戶, 內部: 內部, 各課: 各課, 家數: stores.length, 總表: all, pricing: p };
  }

  function totalOffshoreOf(gd, off) {
    return gd.sectionOrder.reduce(function (a, c) { return a + (Number(off[c]) || 0); }, 0);
  }

  /** 左表 + 右表併排（中間留一欄空白），比照人工版把彙總放在右側 */
  function mergeSideBySide(left, right, right2) {
    var LEFT_W = 6, GAP = 1;
    var rightW = right.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var n = Math.max(left.length, right.length, right2 ? right2.length : 0);
    var out = [];
    for (var i = 0; i < n; i++) {
      var row = [];
      var l = left[i] || [];
      for (var c = 0; c < LEFT_W; c++) row.push(l[c] != null ? l[c] : '');
      for (var g = 0; g < GAP; g++) row.push('');
      var r = right[i] || [];
      for (var c2 = 0; c2 < rightW; c2++) row.push(r[c2] != null ? r[c2] : '');
      if (right2 && right2.length) {
        row.push('');
        var r2 = right2[i] || [];
        var right2W = right2.reduce(function (m, x) { return Math.max(m, x.length); }, 0);
        for (var c3 = 0; c3 < right2W; c3++) row.push(r2[c3] != null ? r2[c3] : '');
      }
      out.push(row);
    }
    return out;
  }

  var api = {
    DEFAULT_PRICING: DEFAULT_PRICING,
    storeTypeOf: storeTypeOf,
    computeGroup: computeGroup,
    groupStores: groupStores,
    buildBillingSheets: buildBillingSheets,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SqcBilling = api;
})(typeof window !== 'undefined' ? window : globalThis);
