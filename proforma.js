/**
 * Robot 3C · lectura de proformas en Excel (.xlsx), sin librerías externas.
 * Un .xlsx es un zip: acá se lee a mano lo mínimo (celdas de texto y números) y se arma una
 * versión liviana sin fotos para mandar por mail. Funciona en el navegador y en Node 18+.
 *
 * Formato que entiende: el de las proformas de Union Trust (fila de títulos con "ITEM NO.",
 * "DESC", "USD PRICE", "QTY"; debajo, una fila por producto). Si el archivo no trae esos
 * títulos, leerProforma avisa y la carga se hace a mano.
 */
var Proforma = (function () {
  var enc = new TextEncoder(), dec = new TextDecoder('utf-8');

  // ---------------------------------------------------------------- zip
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /** Lee el directorio central del zip. */
  function entradas(b) {
    var fin = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
      if (u32(b, i) === 0x06054b50) { fin = i; break; }
    if (fin < 0) throw new Error('El archivo no es un Excel válido');
    var n = u16(b, fin + 10), o = u32(b, fin + 16), lista = [];
    for (var k = 0; k < n; k++) {
      if (u32(b, o) !== 0x02014b50) throw new Error('Excel dañado');
      var nl = u16(b, o + 28), el = u16(b, o + 30), cl = u16(b, o + 32);
      lista.push({ nombre: dec.decode(b.subarray(o + 46, o + 46 + nl)), metodo: u16(b, o + 10),
                   crc: u32(b, o + 16), comp: u32(b, o + 20), tam: u32(b, o + 24), local: u32(b, o + 42) });
      o += 46 + nl + el + cl;
    }
    return lista;
  }
  function crudo(b, e) {      // bytes tal como están guardados (comprimidos)
    var nl = u16(b, e.local + 26), el = u16(b, e.local + 28), ini = e.local + 30 + nl + el;
    return b.subarray(ini, ini + e.comp);
  }
  function flujo(datos, TransformStream) {
    var t = new TransformStream('deflate-raw');
    var w = t.writable.getWriter(); w.write(datos); w.close();
    return new Response(t.readable).arrayBuffer().then(function (a) { return new Uint8Array(a); });
  }
  function contenido(b, e) {
    var c = crudo(b, e);
    return e.metodo === 0 ? Promise.resolve(c) : flujo(c, DecompressionStream);
  }
  function texto(b, lista, nombre) {
    var e = lista.filter(function (x) { return x.nombre === nombre; })[0];
    return e ? contenido(b, e).then(function (d) { return dec.decode(d); }) : Promise.resolve('');
  }

  var TABLA = (function () { var t = [], c; for (var n = 0; n < 256; n++) { c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(d) { var c = 0xFFFFFFFF; for (var i = 0; i < d.length; i++) c = TABLA[(c ^ d[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0; }

  // ---------------------------------------------------------------- lectura de celdas
  function desescapar(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
            .replace(/&amp;/g, '&');
  }
  function textos(xml) {      // sharedStrings: une los fragmentos <t> de cada <si>
    var res = [], re = /<si>([\s\S]*?)<\/si>/g, m;
    while ((m = re.exec(xml))) {
      var t = '', r2 = /<t[^>]*>([\s\S]*?)<\/t>/g, x;
      while ((x = r2.exec(m[1]))) t += x[1];
      res.push(desescapar(t));
    }
    return res;
  }
  function colNum(letras) { var n = 0; for (var i = 0; i < letras.length; i++) n = n * 26 + letras.charCodeAt(i) - 64; return n; }
  function colLetra(n) { var s = ''; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

  /** Devuelve { 'A11': valor, ... } de la primera hoja. */
  function celdas(sheetXml, comp) {
    var res = {}, re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, m;
    while ((m = re.exec(sheetXml))) {
      var at = m[1], cuerpo = m[2] || '';
      var ref = /\br="([A-Z]+\d+)"/.exec(at); if (!ref) continue;
      var tipo = (/\bt="([^"]*)"/.exec(at) || [])[1];
      var v = (/<v>([\s\S]*?)<\/v>/.exec(cuerpo) || [])[1];
      if (tipo === 'inlineStr') { var t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cuerpo); v = t ? desescapar(t[1]) : ''; }
      else if (v === undefined) continue;
      else if (tipo === 's') v = comp[+v];
      else if (tipo === 'str') v = desescapar(v);
      else if (tipo === 'b') v = v === '1';
      else { var n = Number(v); v = isNaN(n) ? v : n; }
      if (v !== '' && v != null) res[ref[1]] = v;
    }
    return res;
  }

  // ---------------------------------------------------------------- proforma
  function filas(c) {
    var mapa = {};
    Object.keys(c).forEach(function (k) {
      var p = /^([A-Z]+)(\d+)$/.exec(k), f = +p[2];
      (mapa[f] = mapa[f] || {})[colNum(p[1])] = c[k];
    });
    return mapa;
  }
  function limpio(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /** Primer valor a la derecha de una etiqueta ("Seller:", "Payments Term:"...). */
  function derecha(mapa, regex, desde, hasta) {
    for (var f = desde; f <= hasta; f++) {
      var fila = mapa[f]; if (!fila) continue;
      var cols = Object.keys(fila).map(Number).sort(function (a, b) { return a - b; });
      for (var i = 0; i < cols.length; i++) {
        if (typeof fila[cols[i]] === 'string' && regex.test(limpio(fila[cols[i]]))) {
          for (var j = i + 1; j < cols.length; j++) { var v = limpio(fila[cols[j]]); if (v !== '' && !/:$/.test(v)) return v; if (/:$/.test(v)) break; }
          return '';
        }
      }
    }
    return '';
  }

  function leerProforma(buf) {
    var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var lista = entradas(b);
    return Promise.all([texto(b, lista, 'xl/sharedStrings.xml'), texto(b, lista, 'xl/worksheets/sheet1.xml')])
      .then(function (r) {
        var c = celdas(r[1], textos(r[0])), mapa = filas(c);
        var ultima = Math.max.apply(null, Object.keys(mapa).map(Number));
        // fila de títulos
        var fT = 0, col = {};
        for (var f = 1; f <= ultima && !fT; f++) {
          var fila = mapa[f] || {}, hit = {};
          Object.keys(fila).forEach(function (k) {
            var t = limpio(fila[k]).toUpperCase();
            if (/^ITEM\s*NO/.test(t)) hit.codigo = +k;
            else if (t === 'DESC' || t === 'DESCRIPTION') hit.detalle = +k;
            else if (t === 'USD PRICE' || t === 'PRICE' || t === 'UNIT PRICE') hit.precio = +k;
            else if (t === 'QTY' || t === 'QUANTITY') hit.cantidad = +k;
            else if (t === 'T.AMOUNT' || t === 'AMOUNT') hit.importe = +k;
          });
          if (hit.codigo && hit.precio && hit.cantidad) { fT = f; col = hit; }
        }
        if (!fT) throw new Error('No encontré la tabla de productos (ITEM NO. / USD PRICE / QTY). Cargala a mano.');
        var items = [], f2 = fT + 1, linea = 1;
        for (; f2 <= ultima; f2++) {
          var fi = mapa[f2] || {}, cod = limpio(fi[col.codigo]);
          var pr = fi[col.precio], q = fi[col.cantidad];
          if (!cod || typeof pr !== 'number' || typeof q !== 'number') break;
          items.push({ linea: linea++, fila: f2, codigo: cod, detalle: limpio(fi[col.detalle]), cantidad: q, precio_unit: pr,
                       importe: typeof fi[col.importe] === 'number' ? fi[col.importe] : Math.round(q * pr * 100) / 100 });
        }
        if (!items.length) throw new Error('La tabla de productos está vacía.');
        var calculado = Math.round(items.reduce(function (s, i) { return s + i.cantidad * i.precio_unit; }, 0) * 100) / 100;
        var totalDoc = null;
        for (var g = f2; g <= ultima && totalDoc === null; g++) {
          var fg = mapa[g] || {};
          Object.keys(fg).forEach(function (k) {
            if (/^total amount/i.test(limpio(fg[k]))) {
              var cs = Object.keys(fg).map(Number).sort(function (a, b) { return a - b; });
              cs.forEach(function (x) { if (x > +k && typeof fg[x] === 'number') totalDoc = fg[x]; });
            }
          });
        }
        var fechaTxt = derecha(mapa, /^date:?$/i, 1, fT);
        var fm = /(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/.exec(fechaTxt);
        return {
          vendedor: derecha(mapa, /^seller:?$/i, 1, fT), comprador: derecha(mapa, /^buyer:?$/i, 1, fT),
          fecha: fm ? fm[1] + '-' + ('0' + fm[2]).slice(-2) + '-' + ('0' + fm[3]).slice(-2) : '',
          contrato: derecha(mapa, /^contract no/i, 1, fT),
          pago: derecha(mapa, /^payments? term/i, f2, ultima),
          puerto_carga: derecha(mapa, /^loading port/i, f2, ultima),
          puerto_destino: derecha(mapa, /^destination port/i, f2, ultima),
          fecha_embarque: derecha(mapa, /^shipping date/i, f2, ultima),
          items: items, total_calculado: calculado, total_documento: totalDoc,
          unidades: items.reduce(function (s, i) { return s + i.cantidad; }, 0),
          coincide_total: totalDoc === null ? null : Math.abs(totalDoc - calculado) < 0.05
        };
      });
  }

  // ---------------------------------------------------------------- versión liviana
  function entrada(nombre, datos, metodo, crc, tam) {
    return { nombre: nombre, datos: datos, metodo: metodo, crc: crc, tam: tam };
  }
  function armarZip(ents) {
    var partes = [], central = [], pos = 0;
    function p16(v) { return [v & 255, (v >> 8) & 255]; }
    function p32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    ents.forEach(function (e) {
      var nom = enc.encode(e.nombre), hdr = [].concat(p32(0x04034b50), p16(20), p16(0x0800), p16(e.metodo), p16(0), p16(0x21),
        p32(e.crc), p32(e.datos.length), p32(e.tam), p16(nom.length), p16(0));
      partes.push(new Uint8Array(hdr), nom, e.datos);
      central.push({ hdr: [].concat(p32(0x02014b50), p16(20), p16(20), p16(0x0800), p16(e.metodo), p16(0), p16(0x21),
        p32(e.crc), p32(e.datos.length), p32(e.tam), p16(nom.length), p16(0), p16(0), p16(0), p16(0), p32(0), p32(pos)), nom: nom });
      pos += hdr.length + nom.length + e.datos.length;
    });
    var ini = pos, tamC = 0;
    central.forEach(function (c) { partes.push(new Uint8Array(c.hdr), c.nom); tamC += c.hdr.length + c.nom.length; });
    partes.push(new Uint8Array([].concat(p32(0x06054b50), p16(0), p16(0), p16(ents.length), p16(ents.length), p32(tamC), p32(ini), p16(0))));
    var total = partes.reduce(function (s, x) { return s + x.length; }, 0), out = new Uint8Array(total), o = 0;
    partes.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }

  /** Copia el Excel sin imágenes ni dibujos (lo que lo hace pesar decenas de MB). */
  function aliviar(buf) {
    var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var lista = entradas(b), tareas = [];
    lista.forEach(function (e) {
      var n = e.nombre;
      if (/^xl\/(media|drawings)\//.test(n)) return;                       // se descarta
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(n) || /^xl\/worksheets\/_rels\/.+\.rels$/.test(n) || n === '[Content_Types].xml') {
        tareas.push(contenido(b, e).then(function (d) {
          var t = dec.decode(d);
          if (/^xl\/worksheets\/sheet/.test(n) && !/_rels/.test(n)) t = t.replace(/<drawing\b[^>]*\/>/g, '').replace(/<legacyDrawing\b[^>]*\/>/g, '');
          else if (/_rels/.test(n)) t = t.replace(/<Relationship\b[^>]*(drawing|image)[^>]*\/>/gi, '');
          else t = t.replace(/<Override\b[^>]*\/xl\/drawings\/[^>]*\/>/g, '');
          var nuevo = enc.encode(t);
          return flujo(nuevo, CompressionStream).then(function (z) { return entrada(n, z, 8, crc32(nuevo), nuevo.length); });
        }));
      } else {
        tareas.push(Promise.resolve(entrada(n, crudo(b, e), e.metodo, e.crc, e.tam)));
      }
    });
    return Promise.all(tareas).then(armarZip);
  }


  /** Saca la foto de cada producto (las imágenes ancladas a la fila de cada ítem; ignora las ocultas). */
  function fotos(buf, items) {
    var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), lista = entradas(b);
    return texto(b, lista, 'xl/worksheets/_rels/sheet1.xml.rels').then(function (rel) {
      var m = /Target="([^"]*drawing[^"]*\.xml)"/.exec(rel); if (!m) return [];
      var dib = m[1].split('/').pop();
      return Promise.all([texto(b, lista, 'xl/drawings/' + dib), texto(b, lista, 'xl/drawings/_rels/' + dib + '.rels')]).then(function (r) {
        var rels = {}, re = /<Relationship\b[^>]*>/g, x;
        while ((x = re.exec(r[1]))) { var id = /Id="([^"]+)"/.exec(x[0]), tg = /Target="([^"]+)"/.exec(x[0]); if (id && tg) rels[id[1]] = tg[1]; }
        var porFila = {}, are = /<xdr:(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g, a;
        while ((a = are.exec(r[0]))) {
          var t = a[0]; if (/hidden="1"/.test(t)) continue;
          var fr = /<xdr:from><xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(t), em = /r:embed="([^"]+)"/.exec(t);
          if (!fr || !em || !rels[em[1]]) continue;
          (porFila[+fr[2] + 1] = porFila[+fr[2] + 1] || []).push({ col: +fr[1], media: 'xl/media/' + rels[em[1]].split('/').pop() });
        }
        var tareas = items.map(function (it) {
          var c = (porFila[it.fila] || []).sort(function (p, q) { return (p.col === 1 ? 0 : 1) - (q.col === 1 ? 0 : 1) || p.col - q.col; })[0];
          var e = c && lista.filter(function (z) { return z.nombre === c.media; })[0];
          return e ? contenido(b, e).then(function (d) { return { linea: it.linea, bytes: d }; }) : null;
        });
        return Promise.all(tareas);
      });
    }).then(function (r) { return r.filter(Boolean); });
  }

  return { leerProforma: leerProforma, fotos: fotos, aliviar: aliviar, _celdas: celdas, _entradas: entradas, _crc32: crc32 };
})();
if (typeof module !== 'undefined') module.exports = Proforma;
