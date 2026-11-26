/**
 * Robot 3C · sección Importaciones (comex).
 * Habla directo con Supabase (Postgres). Para entrar usa el mismo token de Google que
 * ya se obtiene al iniciar sesión, así que no hay una segunda contraseña.
 * En el navegador solo va la clave PUBLICABLE; los permisos los decide la base (RLS).
 */
var IMP = (function () {
  var K = 'sb_sesion';
  var ses = null;                 // { access, refresh, exp, uid }
  var pendiente = null;           // promesa del login en curso
  var E = { estados: [], ops: [], perm: {}, filtro: 'curso', q: '', ok: false };

  try { ses = JSON.parse(localStorage.getItem(K) || 'null'); } catch (e) { ses = null; }

  function activo() { return !!(window.CONFIG && CONFIG.supabase_url && CONFIG.supabase_key); }
  function guardar(d) {
    ses = { access: d.access_token, refresh: d.refresh_token,
            exp: Date.now() + Math.max(60, (d.expires_in || 3600) - 60) * 1000,
            uid: (d.user && d.user.id) || (ses && ses.uid) };
    try { localStorage.setItem(K, JSON.stringify(ses)); } catch (e) {}
  }
  function pedirToken(grant, cuerpo) {
    return fetch(CONFIG.supabase_url + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST', headers: { apikey: CONFIG.supabase_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.access_token) throw new Error(d.error_description || d.msg || d.error || 'No pude entrar a la base');
      guardar(d); return d;
    });
  }
  function acceso() {
    if (ses && Date.now() < ses.exp) return Promise.resolve(ses.access);
    if (ses && ses.refresh)
      return pedirToken('refresh_token', { refresh_token: ses.refresh })
        .then(function (d) { return d.access_token; })
        .catch(function () { ses = null; try { localStorage.removeItem(K); } catch (e) {} throw new Error('sin_sesion'); });
    return Promise.reject(new Error('sin_sesion'));
  }
  function rest(ruta, op) {
    op = op || {};
    return acceso().then(function (tok) {
      var h = { apikey: CONFIG.supabase_key, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
      if (op.devolver) h.Prefer = 'return=representation';
      return fetch(CONFIG.supabase_url + '/rest/v1/' + ruta,
                   { method: op.metodo || 'GET', headers: h, body: op.cuerpo ? JSON.stringify(op.cuerpo) : undefined });
    }).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && (d.message || d.hint)) || 'Error de la base');
        return d;
      });
    });
  }

  var TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function subir(ruta, bytes, tipo) {
    return acceso().then(function (tok) {
      return fetch(CONFIG.supabase_url + '/storage/v1/object/proformas/' + ruta, { method: 'POST',
        headers: { apikey: CONFIG.supabase_key, Authorization: 'Bearer ' + tok, 'x-upsert': 'false',
                   'Content-Type': tipo || TIPO_XLSX }, body: bytes });
    }).then(function (r) {
      if (r.ok) return;
      return r.json().then(function (e) { throw new Error(e.message || 'No pude subir el archivo'); });
    });
  }

  // ------------------------------------------------------------ ingreso
  /** Se llama con el token de Google apenas la persona inicia sesión. */
  function login(idToken) {
    if (!activo() || !idToken) return Promise.resolve();
    pendiente = pedirToken('id_token', { provider: 'google', id_token: idToken })
      .catch(function (e) { E.error = e.message; });
    return pendiente;
  }
  /** Muestra la opción del menú solo si la base reconoce a la persona y tiene un rol. */
  function iniciar() {
    if (!activo()) return;
    Promise.resolve(pendiente).then(function () {
      return rest('perfiles?select=rol,roles(es_admin,ve_dinero,puede_cargar)&user_id=eq.' + (ses && ses.uid));
    }).then(function (p) {
      if (!p || !p.length) throw new Error('sin_perfil');
      var r = p[0].roles || {};
      E.perm = { admin: !!r.es_admin, dinero: !!r.ve_dinero, cargar: !!r.puede_cargar };
      E.ok = true;
      $('tImport').hidden = false;
    }).catch(function () { E.ok = false; $('tImport').hidden = true; });
  }
  function salir() {
    ses = null; pendiente = null; E.ok = false;
    try { localStorage.removeItem(K); } catch (e) {}
    var b = $('tImport'); if (b) b.hidden = true;
  }

  // ------------------------------------------------------------ utilidades
  function fmt(n) { return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fecha(s) { return s ? deIso(s) : '—'; }

  // ------------------------------------------------------------ listado
  function abrir() {
    var s = $('vImport');
    s.innerHTML = '<div class="vacio">Cargando operaciones…</div>';
    Promise.all([
      rest('estados?select=id,nombre,orden,es_final,activo&order=orden'),
      rest('operaciones?select=id,op_numero,eta,etd,transporte,estado_id,estado:estados(nombre,orden,es_final),' +
           'pedido:pedidos(codigo_interno,producto,proveedor:proveedores(nombre),importador:importadores(nombre))' +
           '&order=creado_en.desc')
    ]).then(function (r) { E.estados = r[0]; E.ops = r[1]; pintar(); })
      .catch(function (e) {
        s.innerHTML = '<div class="vacio">' + esc(e.message === 'sin_sesion'
          ? 'Cerrá sesión y volvé a entrar para conectar Importaciones.' : e.message) + '</div>';
      });
  }
  function pintar() {
    var q = norm(E.q);
    var lista = E.ops.filter(function (o) {
      if (E.filtro === 'curso' && o.estado.es_final) return false;
      if (E.filtro !== 'curso' && E.filtro !== 'todas' && o.estado_id !== E.filtro) return false;
      if (!q) return true;
      var p = o.pedido || {};
      return norm([o.op_numero, p.codigo_interno, p.producto, (p.proveedor || {}).nombre].join(' ')).indexOf(q) >= 0;
    });
    var chips = [['curso', 'En curso'], ['todas', 'Todas']].concat(
      E.estados.filter(function (x) { return x.activo; }).map(function (x) { return [x.id, x.nombre]; }));
    var h = '<h2 class="vt">Importaciones</h2>' +
      '<div class="acciones" style="margin-bottom:8px">' +
      (E.perm.cargar ? '<button class="btn" onclick="IMP.nueva()">＋ Nueva operación</button>' : '') +
      (E.perm.admin ? '<button class="btn sec" onclick="IMP.despachante()">⚙ Despachante</button>' : '') + '</div>' +
      '<input class="buscar" id="impQ" placeholder="Buscar OP, producto o proveedor" value="' + esc(E.q) + '" ' +
      'oninput="IMP.buscar(this.value)">' +
      '<div class="chips">' + chips.map(function (c) {
        return '<button class="chip' + (E.filtro === c[0] ? ' act' : '') + '" onclick="IMP.filtrar(\'' + c[0] + '\')">' + esc(c[1]) + '</button>';
      }).join('') + '</div>';
    h += lista.length ? lista.map(function (o) {
      var p = o.pedido || {};
      return '<div class="pedido" onclick="IMP.ficha(\'' + o.id + '\')" style="cursor:pointer">' +
        '<div class="ped-top"><span class="ped-nom">' + (o.op_numero ? 'OP ' + esc(o.op_numero) : esc(p.codigo_interno || 'Sin OP')) + '</span>' +
        '<span class="badge">' + esc(o.estado.nombre) + '</span></div>' +
        '<div class="ped-sub">' + esc(p.producto || '') + ((p.proveedor || {}).nombre ? ' · ' + esc(p.proveedor.nombre) : '') + '</div>' +
        '<div class="ped-sub">ETA ' + fecha(o.eta) + (o.transporte ? ' · ' + esc(o.transporte) : '') + '</div></div>';
    }).join('') : '<div class="vacio">No hay operaciones para este filtro.</div>';
    $('vImport').innerHTML = h;
    var i = $('impQ'); if (i && E.q) { i.focus(); i.setSelectionRange(E.q.length, E.q.length); }
  }
  function filtrar(f) { E.filtro = f; pintar(); }
  function buscar(v) { E.q = v; pintar(); }

  // ------------------------------------------------------------ ficha
  function ficha(id) {
    $('hoja').innerHTML = '<div class="vacio">Cargando…</div>';
    $('velo').style.display = 'block';
    requestAnimationFrame(function () { $('hoja').className = 'hoja abierta'; });
    var pedidos = [rest('operaciones?id=eq.' + id + '&select=*,estado:estados(nombre),' +
      'despachante:despachantes(nombre,envio_activo),unif:operacion_ops_unificadas(op_numero,nota),' +
      'pedido:pedidos(codigo_interno,producto,moneda,proveedor:proveedores(nombre),trader:traders(nombre,comision),importador:importadores(nombre,cuit)),' +
      'items:operacion_items(id,linea,codigo,detalle,cantidad,precio_unit,foto_path)')];
    if (E.perm.dinero) pedidos.push(rest('v_pagos_operacion?operacion_id=eq.' + id));
    Promise.all(pedidos).then(function (r) {
      return firmar((r[0][0].items || []).map(function (i) { return i.foto_path; })).then(function (urls) { pintarFicha(r[0][0], r[1] || [], urls); });
    })
      .catch(function (e) { $('hoja').innerHTML = '<div class="vacio">' + esc(e.message) + '</div>'; });
  }
  var BLOQ = { proveedor: 'Proveedor', logistica: 'Logística', nacionalizacion: 'Nacionalización' };
  var FI = null;
  function pintarFicha(o, pagos, urls) {
    FI = o;
    var p = o.pedido || {}, tot = 0;
    (o.items || []).sort(function (a, b) { return a.linea - b.linea; })
      .forEach(function (i) { tot += i.cantidad * i.precio_unit; });
    var h = '<h2>' + (o.op_numero ? 'OP ' + esc(o.op_numero) : esc(p.codigo_interno)) + '</h2>' +
      '<div class="ped-sub">' + esc(p.codigo_interno) + ' · ' + esc(p.producto || '') + '</div>';
    if (E.perm.cargar) {
      h += '<div class="sub">Estado</div><select id="impEst" onchange="IMP.estado(\'' + o.id + '\',this.value)">' +
        E.estados.filter(function (x) { return x.activo; }).map(function (x) {
          return '<option value="' + x.id + '"' + (x.id === o.estado_id ? ' selected' : '') + '>' + esc(x.nombre) + '</option>';
        }).join('') + '</select>';
    } else h += '<div class="ped-msg">' + esc(o.estado.nombre) + '</div>';
    h += '<div class="sub">Datos</div>' +
      fila('Importador', (p.importador || {}).nombre) + fila('Proveedor', (p.proveedor || {}).nombre) +
      fila('Trader', p.trader ? p.trader.nombre + ' (' + (p.trader.comision * 100) + '%)' : '') +
      fila('Despachante', (o.despachante || {}).nombre) + fila('Transporte', o.transporte) + fila('Tracking', o.tracking) + fila('Comentario', o.comentario) +
      fila('ETD', o.etd ? fecha(o.etd) : '') + fila('ETA', o.eta ? fecha(o.eta) : '') +
      ((o.unif || []).length ? fila('OP unificadas', o.unif.map(function (u) { return u.op_numero; }).join(', ')) : '');
    if (E.perm.cargar) h += '<div class="acciones"><button class="btn sec" onclick="IMP.editarDatos(\'' + o.id + '\')">✎ Editar datos</button></div>';
    h += '<div class="sub">Mail de alta al despachante</div>' + estadoMail(o);
    if (E.perm.admin || (E.perm.cargar && !o.op_numero)) {
      h += '<div class="acciones" style="margin-top:8px"><input id="impOp" placeholder="N° de OP" value="' + esc(o.op_numero || '') + '" style="flex:1">' +
        '<button class="btn sec" onclick="IMP.guardarOp(\'' + o.id + '\')">' + (o.op_numero ? 'Cambiar OP' : 'Asignar OP') + '</button></div>';
    }
    if (E.perm.dinero) {
      h += '<div class="sub">Pagos</div>' + (pagos.length ? pagos.map(function (x) {
        return fila((BLOQ[x.bloque] || x.bloque) + ' (' + x.moneda + ')',
          'debe ' + fmt(x.a_pagar) + ' · pagado ' + fmt(x.pagado) + ' · saldo ' + fmt(x.saldo) + ' · ' + x.estado_pago);
      }).join('') : '<div class="ped-sub">Todavía no hay obligaciones cargadas.</div>');
    }
    h += '<div class="sub">Productos (' + (o.items || []).length + ' líneas · total ' + fmt(tot) + ' ' + esc(p.moneda || 'USD') + ')</div>' +
      tablaItems(o.items || [], p.moneda, { src: function (i) { return urls && urls[i.foto_path] || ''; }, editar: E.perm.cargar ? o.id : '' }) +
      '<div class="acciones" style="margin-top:14px"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>';
    $('hoja').innerHTML = h;
  }
  // ------------------------------------------------------------ edición
  function dato(id, tit, val, tipo) { return '<div class="sub">' + tit + '</div><input id="' + id + '" type="' + (tipo || 'text') + '" value="' + esc(val == null ? '' : val) + '" style="width:100%">'; }
  function vv(id) { return ($(id).value || '').trim(); }
  function nul(v) { return v === '' ? null : v; }
  function bitacora(id, ev, det) { rest('eventos', { metodo: 'POST', cuerpo: { operacion_id: id, evento: ev, detalle: det || {}, usuario: ses && ses.uid } }).catch(function () {}); }
  function editarDatos(id) {
    var o = FI, p = o.pedido || {};
    $('hoja').innerHTML = '<h2 class="vt">Editar datos</h2>' +
      '<div class="sub">Pedido</div>' +
      dato('edProd', 'Producto', p.producto) + dato('edInc', 'Incoterm', p.incoterm) + dato('edPago', 'Forma de pago', p.forma_pago) +
      dato('edMon', 'Moneda', p.moneda) + dato('edPc', 'Puerto de carga', p.puerto_carga) + dato('edPd', 'Puerto de destino', p.puerto_destino) +
      dato('edCom', 'Comentario del pedido', p.comentario) +
      '<div class="sub" style="margin-top:14px">Operación</div>' +
      dato('edTr', 'Transporte (marítimo, aéreo…)', o.transporte) + dato('edTk', 'Tracking', o.tracking) +
      dato('edEtd', 'ETD (salida)', o.etd, 'date') + dato('edEta', 'ETA (llegada estimada)', o.eta, 'date') +
      dato('edArr', 'Fecha de arribo', o.fecha_arribo, 'date') + dato('edLib', 'Fecha de liberación', o.fecha_liberacion, 'date') +
      dato('edOc', 'Comentario de la operación', o.comentario) +
      '<div class="ped-msg" id="edMsg" style="display:none"></div>' +
      '<div class="acciones" style="margin-top:14px"><button class="btn" onclick="IMP.guardarDatos(\'' + id + '\')">Guardar</button>' +
      '<button class="btn sec" onclick="IMP.ficha(\'' + id + '\')">Cancelar</button></div>';
  }
  function guardarDatos(id) {
    var o = FI;
    var ped = { producto: vv('edProd') || (o.pedido || {}).producto, incoterm: nul(vv('edInc')), forma_pago: nul(vv('edPago')),
      moneda: vv('edMon') || (o.pedido || {}).moneda || 'USD', puerto_carga: nul(vv('edPc')), puerto_destino: nul(vv('edPd')), comentario: nul(vv('edCom')) };
    var op = { transporte: nul(vv('edTr')), tracking: nul(vv('edTk')), etd: nul(vv('edEtd')), eta: nul(vv('edEta')),
      fecha_arribo: nul(vv('edArr')), fecha_liberacion: nul(vv('edLib')), comentario: nul(vv('edOc')) };
    Promise.all([rest('pedidos?id=eq.' + o.pedido_id, { metodo: 'PATCH', cuerpo: ped }), rest('operaciones?id=eq.' + id, { metodo: 'PATCH', cuerpo: op })])
      .then(function () { bitacora(id, 'datos editados', { pedido: ped, operacion: op }); toast('Datos guardados'); abrir(); ficha(id); })
      .catch(function (e) { toast(e.message || e); });
  }
  function editarItem(opId, itemId) {
    var o = FI, it = (o.items || []).filter(function (x) { return x.id === itemId; })[0], nuevo = !it;
    if (nuevo) { var mx = 0; (o.items || []).forEach(function (x) { if (x.linea > mx) mx = x.linea; }); it = { linea: mx + 1, codigo: '', detalle: '', cantidad: '', precio_unit: '' }; }
    $('hoja').innerHTML = '<h2 class="vt">' + (nuevo ? 'Agregar producto' : 'Editar producto') + '</h2>' +
      dato('edLin', 'N° de línea', it.linea, 'number') + dato('edCod', 'Código', it.codigo) + dato('edDet', 'Descripción', it.detalle) +
      dato('edCan', 'Cantidad', it.cantidad, 'number') + dato('edPre', 'Precio unitario', it.precio_unit, 'number') +
      '<div class="acciones" style="margin-top:14px"><button class="btn" onclick="IMP.guardarItem(\'' + opId + '\',\'' + (nuevo ? '' : itemId) + '\')">Guardar</button>' +
      '<button class="btn sec" onclick="IMP.ficha(\'' + opId + '\')">Cancelar</button>' +
      (nuevo ? '' : '<button class="btn sec" style="margin-left:auto;color:#e5484d" onclick="IMP.borrarItem(\'' + opId + '\',\'' + itemId + '\')">Sacar</button>') + '</div>';
  }
  function guardarItem(opId, itemId) {
    var c = { linea: Number(vv('edLin')), codigo: nul(vv('edCod')), detalle: vv('edDet'), cantidad: Number(vv('edCan')), precio_unit: Number(vv('edPre')) };
    if (!c.detalle || !(c.linea > 0) || !(c.cantidad >= 0) || isNaN(c.precio_unit) || vv('edCan') === '' || vv('edPre') === '') { toast('Completá línea, descripción, cantidad y precio'); return; }
    var q = itemId ? rest('operacion_items?id=eq.' + itemId, { metodo: 'PATCH', cuerpo: c })
                   : (c.operacion_id = opId, rest('operacion_items', { metodo: 'POST', cuerpo: c }));
    q.then(function () { bitacora(opId, itemId ? 'producto editado' : 'producto agregado', c); toast('Guardado'); ficha(opId); })
     .catch(function (e) { toast(e.message || e); });
  }
  function borrarItem(opId, itemId) {
    if (!confirm('¿Sacar este producto de la operación?')) return;
    var it = (FI.items || []).filter(function (x) { return x.id === itemId; })[0] || {};
    rest('operacion_items?id=eq.' + itemId, { metodo: 'DELETE' })
      .then(function () { bitacora(opId, 'producto quitado', { linea: it.linea, detalle: it.detalle }); toast('Producto sacado'); ficha(opId); })
      .catch(function (e) { toast(e.message || e); });
  }

  // ------------------------------------------------------------ fotos de productos
  /** Reduce la foto (los originales pesan cientos de KB) a una miniatura de buena calidad. */
  function achicar(blob, max) {
    return createImageBitmap(blob).then(function (bm) {
      var k = Math.min(1, max / Math.max(bm.width, bm.height)), c = document.createElement('canvas'), x;
      c.width = Math.max(1, Math.round(bm.width * k)); c.height = Math.max(1, Math.round(bm.height * k));
      x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bm, 0, 0, c.width, c.height);
      return new Promise(function (ok, ko) { c.toBlob(function (b) { b ? ok(b) : ko(new Error('Imagen inválida')); }, 'image/jpeg', 0.8); });
    });
  }
  /** URLs temporales (1 h) para ver las fotos del bucket privado. */
  function firmar(paths) {
    paths = paths.filter(Boolean);
    if (!paths.length) return Promise.resolve({});
    return acceso().then(function (tok) {
      return fetch(CONFIG.supabase_url + '/storage/v1/object/sign/proformas', { method: 'POST',
        headers: { apikey: CONFIG.supabase_key, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600, paths: paths }) });
    }).then(function (r) { return r.json(); }).then(function (l) {
      var m = {}; (Array.isArray(l) ? l : []).forEach(function (x) { if (x.signedURL) m[x.path] = CONFIG.supabase_url + '/storage/v1' + x.signedURL; });
      return m;
    }).catch(function () { return {}; });
  }
  function ver(src) {
    var v = document.createElement('div');
    v.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99;display:flex;align-items:center;justify-content:center;padding:12px';
    v.innerHTML = '<img src="' + src + '" style="max-width:100%;max-height:100%;border-radius:8px">';
    v.onclick = function () { document.body.removeChild(v); };
    document.body.appendChild(v);
  }
  var FOTO_ITEM = null;
  /** Subir o cambiar la foto de un producto (cámara o galería). */
  function elegirFoto(itemId, opId) {
    FOTO_ITEM = { id: itemId, op: opId };
    var i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
    i.onchange = function () {
      var f = i.files && i.files[0]; if (!f) return;
      toast('Subiendo foto…');
      var ruta = new Date().getFullYear() + '/fotos/' + FOTO_ITEM.id + '-' + Date.now() + '.jpg';
      achicar(f, 560).then(function (b) { return subir(ruta, b, 'image/jpeg'); })
        .then(function () { return rest('operacion_items?id=eq.' + FOTO_ITEM.id, { metodo: 'PATCH', cuerpo: { foto_path: ruta } }); })
        .then(function () { toast('Foto guardada'); ficha(FOTO_ITEM.op); })
        .catch(function (e) { toast(e.message || e); });
    };
    i.click();
  }

  /** Cuadro de productos como en el Excel: código, descripción, cantidad, precio, importe y totales. */
  function tablaItems(items, moneda, op) {
    var u = 0, t = 0, o = op || {};
    var filas = items.map(function (i) {
      var imp = Math.round(i.cantidad * i.precio_unit * 100) / 100; u += Number(i.cantidad); t += imp;
      var src = o.src ? o.src(i) : '', foto = src
        ? '<img src="' + src + '" class="mini" onclick="IMP.ver(this.src)">'
        : (o.editar && i.id ? '<button class="mini vacia" onclick="IMP.elegirFoto(\'' + i.id + '\',\'' + o.editar + '\')">＋</button>' : '');
      if (src && o.editar && i.id) foto += '<div><button class="chip" style="padding:1px 8px;font-size:11px" onclick="IMP.elegirFoto(\'' + i.id + '\',\'' + o.editar + '\')">cambiar</button></div>';
      return '<tr><td class="c">' + esc(i.linea) + '</td><td class="f">' + foto + '</td><td>' + esc(i.codigo || '') + '</td><td class="d">' + esc(i.detalle) +
             '</td><td class="n">' + fmt0(i.cantidad) + '</td><td class="n">' + fmt(i.precio_unit) + '</td><td class="n">' + fmt(imp) + '</td>' +
             (o.editar && i.id ? '<td class="c"><button class="chip" style="padding:2px 9px" onclick="IMP.editarItem(\'' + o.editar + '\',\'' + i.id + '\')">✎</button></td>' : (o.editar ? '<td></td>' : '')) + '</tr>';
    }).join('');
    return '<div class="tabla-items"><table><thead><tr><th>#</th><th>Foto</th><th>Código</th><th>Descripción</th><th>Cant.</th><th>Precio ' + esc(moneda || 'USD') +
           '</th><th>Importe</th>' + (o.editar ? '<th></th>' : '') + '</tr></thead><tbody>' + filas + '</tbody><tfoot><tr><td colspan="4">Total</td><td class="n">' + fmt0(u) +
           '</td><td></td><td class="n">' + fmt(t) + '</td>' + (o.editar ? '<td></td>' : '') + '</tr></tfoot></table></div>' +
           (o.editar ? '<div class="acciones" style="margin-top:8px"><button class="btn sec" onclick="IMP.editarItem(\'' + o.editar + '\',\'\')">＋ Agregar producto</button></div>' : '');
  }
  function fmt0(n) { return Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 }); }
  function fila(k, v) { return v ? '<div class="ped-sub"><b>' + esc(k) + ':</b> ' + esc(v) + '</div>' : ''; }

  function estado(id, estadoId) {
    rest('operaciones?id=eq.' + id, { metodo: 'PATCH', cuerpo: { estado_id: estadoId } })
      .then(function () {
        rest('eventos', { metodo: 'POST', cuerpo: { operacion_id: id, evento: 'estado cambiado', detalle: { estado_id: estadoId }, usuario: ses && ses.uid } }).catch(function () {});
        toast('Estado actualizado'); abrir();
      }).catch(function (e) { toast(e.message); });
  }
  function guardarOp(id) {
    var v = ($('impOp').value || '').trim();
    if (!v) { toast('Escribí el N° de OP'); return; }
    rest('operaciones?id=eq.' + id, { metodo: 'PATCH', cuerpo: { op_numero: v } })
      .then(function () { toast('OP guardada'); abrir(); ficha(id); })
      .catch(function (e) { toast(/duplicate|unique/i.test(e.message) ? 'Ese N° de OP ya existe' : e.message); });
  }


  // ------------------------------------------------------------ mail de alta
  function saludo() { var h = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' })) % 24;
    return h < 12 ? 'Buenos días' : (h < 20 ? 'Buenas tardes' : 'Buenas noches'); }
  function rellenar(t, v) { return String(t || '').replace(/\{(\w+)\}/g, function (m, k) { return v[k] != null ? v[k] : m; }); }
  function estadoMail(o) {
    if (o.mail_alta_enviado_en) return '<div class="ped-sub">Enviado el ' + esc(new Date(o.mail_alta_enviado_en).toLocaleString('es-AR')) + '</div>';
    if (o.mail_alta_solicitado_en) return '<div class="ped-sub">En cola: sale en los próximos minutos.</div>';
    if (!o.proforma_liviana_path) return '<div class="ped-sub">Esta operación no tiene proforma cargada desde la app.</div>';
    if (!(o.despachante && o.despachante.envio_activo)) return '<div class="ped-sub">No enviado. El envío está desactivado (⚙ Despachante).</div>';
    return '<div class="ped-sub">No enviado.</div>' + (E.perm.cargar ?
      '<div class="acciones"><button class="btn sec" onclick="IMP.pedirMail(\'' + o.id + '\')">Enviar mail de alta</button></div>' : '');
  }
  function pedirMail(id) {
    rest('operaciones?id=eq.' + id + '&mail_alta_enviado_en=is.null', { metodo: 'PATCH', cuerpo: { mail_alta_solicitado_en: new Date().toISOString() } })
      .then(function () { toast('Mail en cola'); ficha(id); }).catch(function (e) { toast(e.message); });
  }

  // ------------------------------------------------------------ alta desde proforma
  var ALTA = null;
  function clave(s) { return norm(s).replace(/[^a-z0-9]/g, ''); }
  function nueva() {
    ALTA = null;
    $('vImport').innerHTML = '<h2 class="vt">Nueva operación</h2>' +
      '<div class="ped-sub">Subí la proforma (Excel o PDF). Vas a revisar los datos antes de confirmar.</div>' +
      '<input type="file" id="impArch" accept=".xlsx,.pdf" onchange="IMP.leerArchivo(this)" style="margin-top:12px">' +
      '<div class="ped-msg" id="impMsg"></div>' +
      '<div class="acciones" style="margin-top:12px"><button class="btn sec" onclick="IMP.abrir()">Volver</button></div>';
  }
  function leerPdf(bytes) {
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
        ruta = new Date().getFullYear() + '/' + id + '/proforma.pdf';
    $('impMsg').textContent = 'Subiendo el PDF…';
    return subir(ruta, bytes, 'application/pdf').then(function () {
      $('impMsg').textContent = 'Leyendo el PDF con IA (puede tardar un minuto)…';
      return acceso();
    }).then(function (tok) {
      return fetch(CONFIG.supabase_url + '/functions/v1/leer-proforma', { method: 'POST',
        headers: { apikey: CONFIG.supabase_key, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ruta }) });
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'No pude leer el PDF'); ALTA.ruta = ruta; return d; });
    });
  }
  function leerArchivo(inp) {
    var f = inp.files && inp.files[0]; if (!f) return;
    var esPdf = /\.pdf$/i.test(f.name);
    $('impMsg').textContent = 'Leyendo la proforma…';
    Promise.all([f.arrayBuffer(), Promise.all([
      rest('importadores?select=id,nombre&activo=eq.true&order=nombre'), rest('proveedores?select=id,nombre&order=nombre'),
      rest('traders?select=id,nombre&order=nombre'),
      rest('despachantes?select=id,nombre,destinatarios,copia,envio_activo,asunto_plantilla,cuerpo_plantilla&order=nombre')])])
      .then(function (r) {
        ALTA = { buf: new Uint8Array(r[0]), nombre: f.name, tipo: esPdf ? 'pdf' : 'xlsx', imp: r[1][0], prov: r[1][1], tr: r[1][2], desp: r[1][3] };
        return esPdf ? leerPdf(ALTA.buf) : Proforma.leerProforma(ALTA.buf);
      }).then(function (d) {
        ALTA.d = d; ALTA.fotos = {};
        if (esPdf) return;
        $('impMsg').textContent = 'Preparando las fotos de los productos…';
        return Proforma.fotos(ALTA.buf, d.items).then(function (fs) {
          return Promise.all(fs.map(function (x) {
            return achicar(new Blob([x.bytes]), 560).then(function (b) { ALTA.fotos[x.linea] = { blob: b, url: URL.createObjectURL(b) }; }).catch(function () {});
          }));
        }).catch(function () {});
      }).then(function () { formulario(); })
      .catch(function (e) { $('impMsg').textContent = e.message || String(e); });
  }
  function opciones(lista, buscado, nuevoNombre, conVacio) {
    var k = clave(buscado), hit = lista.filter(function (x) { return clave(x.nombre) === k; })[0];
    return (conVacio ? '<option value="">— sin trader —</option>' : '') + lista.map(function (x) {
      return '<option value="' + x.id + '"' + (hit && hit.id === x.id ? ' selected' : '') + '>' + esc(x.nombre) + '</option>'; }).join('') +
      (nuevoNombre ? '<option value="__nuevo"' + (!hit ? ' selected' : '') + '>Crear: ' + esc(nuevoNombre) + '</option>' : '');
  }
  function resumenProducto(items) {
    var vistos = [];
    items.forEach(function (i) { var t = i.detalle.split(',')[0].trim(); if (t && vistos.indexOf(t) < 0) vistos.push(t); });
    return vistos.slice(0, 5).join(', ') + (vistos.length > 5 ? '…' : '');
  }
  function campo(id, tit, val) { return '<div class="sub">' + tit + '</div><input id="' + id + '" value="' + esc(val || '') + '" style="width:100%">'; }
  function formulario() {
    var d = ALTA.d, ds = ALTA.desp[0] || {};
    var h = '<h2 class="vt">Revisá la proforma</h2>' +
      '<div class="ped-sub">' + esc(ALTA.nombre) + '</div>' +
      (ALTA.tipo === 'pdf' ? '<div class="ped-msg">⚠ Leído con IA: revisá bien cada dato y los productos antes de confirmar.</div>' : '') +
      ((d.advertencias || []).length ? '<div class="ped-msg">' + d.advertencias.map(esc).join('<br>') + '</div>' : '') +
      '<div class="ped-msg">' + d.items.length + ' productos · ' + fmt(d.unidades) + ' unidades · total ' + fmt(d.total_calculado) + ' USD' +
      (d.coincide_total === true ? ' ✔ coincide con el total del documento' :
       d.coincide_total === false ? ' ⚠ el documento dice ' + fmt(d.total_documento) + ': revisalo' : '') + '</div>' +
      '<div class="sub">Importador (comprador)</div><select id="impImp">' + opciones(ALTA.imp, d.comprador, d.comprador) + '</select>' +
      '<div class="sub">Proveedor (vendedor)</div><select id="impProv">' + opciones(ALTA.prov, d.vendedor, d.vendedor) + '</select>' +
      '<div class="sub">Trader (si hay)</div><select id="impTr">' + opciones(ALTA.tr, '', '', true) + '</select>' +
      campo('impProd', 'Producto', resumenProducto(d.items)) + campo('impPc', 'Puerto de carga', d.puerto_carga) +
      campo('impPd', 'Puerto de destino', d.puerto_destino) + campo('impPago', 'Forma de pago', d.pago) +
      campo('impInc', 'Incoterm', d.incoterm) + campo('impMon', 'Moneda', d.moneda || 'USD') +
      campo('impFec', 'Fecha de la proforma (AAAA-MM-DD)', d.fecha) + campo('impCom', 'Comentario', '') +
      '<div class="sub">Productos' + (Object.keys(ALTA.fotos || {}).length ? ' (' + Object.keys(ALTA.fotos).length + ' con foto)' : '') + '</div>' +
      tablaItems(d.items, d.moneda, { src: function (i) { return ALTA.fotos && ALTA.fotos[i.linea] ? ALTA.fotos[i.linea].url : ''; } }) +
      '<div class="sub">Mail de alta</div>' + vistaMail(ds, d) +
      '<div class="acciones" style="margin-top:14px"><button class="btn" id="impOk" onclick="IMP.confirmar(this)">Confirmar alta</button>' +
      '<button class="btn sec" onclick="IMP.nueva()">Cancelar</button></div><div class="ped-msg" id="impMsg"></div>';
    $('vImport').innerHTML = h;
  }
  function vistaMail(ds, d) {
    if (!ds.id) return '<div class="ped-sub">No hay despachante cargado.</div>';
    var v = { saludo: saludo(), proveedor: d.vendedor, codigo_interno: 'PED-…' };
    return '<div class="ped-sub"><b>Para:</b> ' + esc((ds.destinatarios || []).join(', ') || '—') + '</div>' +
      '<div class="ped-sub"><b>CC:</b> ' + esc((ds.copia || []).join(', ') || '—') + '</div>' +
      '<div class="ped-sub"><b>Asunto:</b> ' + esc(rellenar(ds.asunto_plantilla, v)) + '</div>' +
      '<div class="ped-sub" style="white-space:pre-wrap">' + esc(rellenar(ds.cuerpo_plantilla, v)) + '</div>' +
      '<div class="ped-sub"><b>Adjunto:</b> ' + (ALTA.tipo === 'pdf' ? 'la proforma en PDF' : 'proforma sin fotos + link a la original en Drive') + '</div>' +
      '<div class="ped-msg">' + (ds.envio_activo ? 'Al confirmar, el mail sale solo.' : 'El envío está desactivado: NO se manda ningún mail. Se puede enviar después desde la ficha.') + '</div>';
  }
  function confirmar(btn) {
    var d = ALTA.d, ds = ALTA.desp[0] || {}, msg = $('impMsg');
    var imp = $('impImp').value, prov = $('impProv').value;
    if (!$('impProd').value.trim()) { msg.textContent = 'Falta el producto'; return; }
    btn.disabled = true; msg.textContent = 'Subiendo la proforma…';
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
        base = new Date().getFullYear() + '/' + id + '/', pOrig = base + 'proforma.xlsx', pLite = base + 'proforma-sin-fotos.xlsx';
    var subida = ALTA.tipo === 'pdf'
      ? (pOrig = pLite = ALTA.ruta, Promise.resolve())          // el PDF ya se subió al leerlo
      : Proforma.aliviar(ALTA.buf).then(function (lite) { return subir(pOrig, ALTA.buf).then(function () { return subir(pLite, lite); }); });
    subida
      .then(function () {
        var ls = Object.keys(ALTA.fotos || {}), hechas = 0, rutas = {};
        function una() {
          var l = ls.shift(); if (!l) return Promise.resolve();
          var r = base + 'fotos/' + l + '.jpg';
          return subir(r, ALTA.fotos[l].blob, 'image/jpeg').then(function () { rutas[l] = r; msg.textContent = 'Subiendo fotos (' + (++hechas) + ')…'; }).catch(function () {}).then(una);
        }
        return Promise.all([una(), una(), una(), una()]).then(function () { ALTA.rutas = rutas; });
      }).then(function () {
        msg.textContent = 'Creando el pedido y la operación…';
        return rest('rpc/alta_operacion', { metodo: 'POST', cuerpo: { p: {
          importador_id: imp === '__nuevo' ? '' : imp, importador_nuevo: imp === '__nuevo' ? d.comprador : '',
          proveedor_id: prov === '__nuevo' ? '' : prov, proveedor_nuevo: prov === '__nuevo' ? d.vendedor : '',
          trader_id: $('impTr').value, incoterm: $('impInc').value.trim(), moneda: $('impMon').value.trim(), producto: $('impProd').value.trim(), forma_pago: $('impPago').value.trim(),
          puerto_carga: $('impPc').value.trim(), puerto_destino: $('impPd').value.trim(), fecha_proforma: $('impFec').value.trim(),
          comentario: $('impCom').value.trim(), despachante_id: ds.id, proforma_path: pOrig, proforma_liviana_path: pLite,
          enviar_mail: !!ds.envio_activo, items: d.items.map(function (i) {
            return { linea: i.linea, codigo: i.codigo, detalle: i.detalle, cantidad: i.cantidad, precio_unit: i.precio_unit, foto_path: (ALTA.rutas || {})[i.linea] || '' }; }) } } });
      }).then(function (r) { toast('Operación creada: ' + r.codigo_interno); abrir(); ficha(r.operacion_id); })
      .catch(function (e) { btn.disabled = false; msg.textContent = 'No se pudo crear: ' + (e.message || e); });
  }

  // ------------------------------------------------------------ despachante (admin)
  function despachante() {
    rest('despachantes?select=*&order=nombre').then(function (l) {
      var x = l[0]; if (!x) { toast('No hay despachante'); return; }
      $('hoja').innerHTML = '<h2>' + esc(x.nombre) + '</h2>' +
        '<div class="sub">Para (uno por línea)</div><textarea id="dsPara" rows="3" style="width:100%">' + esc((x.destinatarios || []).join('\n')) + '</textarea>' +
        '<div class="sub">CC (uno por línea)</div><textarea id="dsCc" rows="3" style="width:100%">' + esc((x.copia || []).join('\n')) + '</textarea>' +
        '<div class="sub">Asunto</div><input id="dsAsu" value="' + esc(x.asunto_plantilla || '') + '" style="width:100%">' +
        '<div class="sub">Texto ({saludo}, {proveedor} y {codigo_interno} se completan solos)</div>' +
        '<textarea id="dsCue" rows="6" style="width:100%">' + esc(x.cuerpo_plantilla || '') + '</textarea>' +
        '<label style="display:block;margin-top:12px"><input type="checkbox" id="dsAct"' + (x.envio_activo ? ' checked' : '') +
        '> Envío de mails activado</label><div class="ped-sub">Apagado = el sistema no manda ningún mail.</div>' +
        '<div class="acciones" style="margin-top:14px"><button class="btn" onclick="IMP.guardarDespachante(\'' + x.id + '\')">Guardar</button>' +
        '<button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>';
      $('velo').style.display = 'block';
      requestAnimationFrame(function () { $('hoja').className = 'hoja abierta'; });
    }).catch(function (e) { toast(e.message); });
  }
  function mails(t) { return String(t || '').split(/[\s,;]+/).filter(function (m) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m); }); }
  function guardarDespachante(id) {
    rest('despachantes?id=eq.' + id, { metodo: 'PATCH', cuerpo: { destinatarios: mails($('dsPara').value), copia: mails($('dsCc').value),
      asunto_plantilla: $('dsAsu').value, cuerpo_plantilla: $('dsCue').value, envio_activo: $('dsAct').checked } })
      .then(function () { toast('Guardado'); cerrarHoja(); }).catch(function (e) { toast(e.message); });
  }

  return { login: login, iniciar: iniciar, salir: salir, abrir: abrir, filtrar: filtrar, buscar: buscar,
           ficha: ficha, estado: estado, guardarOp: guardarOp, nueva: nueva, leerArchivo: leerArchivo, editarDatos: editarDatos, guardarDatos: guardarDatos, editarItem: editarItem, guardarItem: guardarItem, borrarItem: borrarItem, ver: ver, elegirFoto: elegirFoto,
           confirmar: confirmar, despachante: despachante, guardarDespachante: guardarDespachante, pedirMail: pedirMail };
})();
