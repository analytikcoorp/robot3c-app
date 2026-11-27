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
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; }
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
      (E.perm.admin ? '<button class="btn sec" onclick="IMP.despachante()">⚙ Despachante</button><button class="btn sec" onclick="IMP.valoresDefecto()">⚙ Cálculos</button>' : '') + '</div>' +
      '<input class="buscar" id="impQ" placeholder="Buscar OP, producto o proveedor" value="' + esc(E.q) + '" ' +
      'oninput="IMP.buscar(this.value)">' +
      '<div class="chips">' + chips.map(function (c) {
        return '<button class="chip' + (E.filtro === c[0] ? ' act' : '') + '" onclick="IMP.filtrar(\'' + c[0] + '\')">' + esc(c[1]) + '</button>';
      }).join('') + '</div>';
    h += lista.length ? lista.map(function (o) {
      var p = o.pedido || {};
      return '<div class="pedido" onclick="IMP.ficha(\'' + o.id + '\')" style="cursor:pointer">' +
        '<div class="ped-top"><span class="ped-nom">' + (o.op_numero ? 'OP ' + esc(o.op_numero) : esc(p.codigo_interno || 'Sin OP')) + '</span>' +
        '<span style="display:flex;align-items:center;gap:8px"><span class="badge">' + esc(o.estado.nombre) + '</span>' +
        (E.perm.admin ? '<button class="chip" title="Eliminar operación" style="padding:2px 10px;color:#e5484d" onclick="event.stopPropagation();IMP.eliminar(\'' + o.id + '\')">✕</button>' : '') + '</span></div>' +
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
    EI = null; TE = null; GE = null;
    $('hoja').innerHTML = '<div class="vacio">Cargando…</div>';
    $('velo').style.display = 'block';
    requestAnimationFrame(function () { $('hoja').className = 'hoja abierta'; });
    var pedidos = [rest('operaciones?id=eq.' + id + '&select=*,estado:estados(nombre),' +
      'despachante:despachantes(nombre,envio_activo),unif:operacion_ops_unificadas(op_numero,nota),' +
      'pedido:pedidos(codigo_interno,producto,moneda,proveedor:proveedores(nombre),trader:traders(nombre,comision),importador:importadores(nombre,cuit)),' +
      'items:operacion_items(id,linea,codigo,detalle,cantidad,precio_unit,foto_path)')];
    if (E.perm.dinero) { pedidos.push(rest('v_pagos_operacion?operacion_id=eq.' + id)); pedidos.push(rest('pagos_operacion?operacion_id=eq.' + id + '&order=fecha,creado_en')); }
    Promise.all(pedidos).then(function (r) {
      return firmar((r[0][0].items || []).map(function (i) { return i.foto_path; })).then(function (urls) { pintarFicha(r[0][0], r[1] || [], urls, r[2] || []); });
    })
      .catch(function (e) { $('hoja').innerHTML = '<div class="vacio">' + esc(e.message) + '</div>'; });
  }
  var BLOQ = { proveedor: 'Proveedor', logistica: 'Logística', nacionalizacion: 'Nacionalización' };
  var FI = null;
  function pintarFicha(o, pagos, urls, pp) {
    FI = o; o._pagos = pp || []; LAST = [o, pagos, urls, pp];
    var p = o.pedido || {}, tot = 0;
    (o.items || []).sort(function (a, b) { return a.linea - b.linea; })
      .forEach(function (i) { tot += i.cantidad * i.precio_unit; });
    var h = pestanas(o.id, 'op') +
      '<h2>' + (o.op_numero ? 'OP ' + esc(o.op_numero) : esc(p.codigo_interno)) + ((p.proveedor || {}).nombre ? ' · ' + esc(p.proveedor.nombre) : '') + '</h2>' +
      '<div class="ped-sub">' + esc(p.codigo_interno) + ' · ' + esc(p.producto || '') + '</div>';
    if (E.perm.dinero) {
      var pg = 0; o._pagos.forEach(function (x) { pg += Number(x.monto); });
      h += '<div class="ped-msg"><b>Saldo con el proveedor: ' + fmt(tot - pg) + ' ' + esc(p.moneda || 'USD') + '</b><br>Total ' + fmt(tot) + ' · pagado ' + fmt(pg) + '</div>';
    }
    if (E.perm.cargar) {
      h += '<div class="sub">Estado</div><select id="impEst" onchange="IMP.estado(\'' + o.id + '\',this.value)">' +
        E.estados.filter(function (x) { return x.activo; }).map(function (x) {
          return '<option value="' + x.id + '"' + (x.id === o.estado_id ? ' selected' : '') + '>' + esc(x.nombre) + '</option>';
        }).join('') + '</select>';
    } else h += '<div class="ped-msg">' + esc(o.estado.nombre) + '</div>';
    h += '<div class="sub" style="display:flex;align-items:center;gap:8px">Datos' + (E.perm.cargar ?
      '<button class="chip" style="padding:2px 10px;font-size:15px;text-transform:none" title="Editar datos" onclick="IMP.editarDatos(\'' + o.id + '\')">✎</button>' : '') + '</div>' +
      fila('Importador', (p.importador || {}).nombre) + fila('Proveedor', (p.proveedor || {}).nombre) +
      fila('Trader', p.trader ? p.trader.nombre + ' (' + (p.trader.comision * 100) + '%)' : '') +
      fila('Despachante', (o.despachante || {}).nombre) + fila('Transporte', o.transporte) + fila('Tracking', o.tracking) + fila('Comentario', o.comentario) +
      fila('ETD', o.etd ? fecha(o.etd) : '') + fila('ETA', o.eta ? fecha(o.eta) : '') +
      ((o.unif || []).length ? fila('OP unificadas', o.unif.map(function (u) { return u.op_numero; }).join(', ')) : '');
    h += '<div class="sub">Mail de alta al despachante</div>' + estadoMail(o);
    if (E.perm.admin || (E.perm.cargar && !o.op_numero)) {
      h += '<div class="acciones" style="margin-top:8px"><input id="impOp" placeholder="N° de OP" value="' + esc(o.op_numero || '') + '" style="flex:1">' +
        '<button class="btn sec" onclick="IMP.guardarOp(\'' + o.id + '\')">' + (o.op_numero ? 'Cambiar OP' : 'Asignar OP') + '</button></div>';
    }
    if (E.perm.dinero) {
      h += '<div class="sub" style="display:flex;align-items:center;gap:8px">Pagos al proveedor' + (E.perm.cargar ?
        '<button class="chip" style="padding:2px 10px;font-size:15px;text-transform:none" title="Registrar pago" onclick="IMP.editarPago(\'' + o.id + '\',\'\')">＋</button>' : '') + '</div>' + (o._pagos.length ? o._pagos.map(function (x) {
        return '<div class="ped-sub" style="display:flex;align-items:center;gap:8px"><span style="flex:1"><b>' + esc(x.concepto) + '</b> · ' + esc(fecha(x.fecha)) + ' · ' + fmt(x.monto) + ' ' + esc(x.moneda) +
          (x.comentario ? ' · ' + esc(x.comentario) : '') + '</span><button class="chip" style="padding:2px 9px" onclick="IMP.editarPago(\'' + o.id + '\',\'' + x.id + '\')">✎</button></div>';
      }).join('') : '<div class="ped-sub">Todavía no hay pagos registrados.</div>') +
        '<div class="sub">Obligaciones por bloque</div>' + (pagos.length ? pagos.map(function (x) {
        return fila((BLOQ[x.bloque] || x.bloque) + ' (' + x.moneda + ')',
          'debe ' + fmt(x.a_pagar) + ' · pagado ' + fmt(x.pagado) + ' · saldo ' + fmt(x.saldo) + ' · ' + x.estado_pago);
      }).join('') : '<div class="ped-sub">Todavía no hay obligaciones cargadas.</div>');
    }
    h += '<div class="sub">Productos (' + (o.items || []).length + ' líneas · total ' + fmt(tot) + ' ' + esc(p.moneda || 'USD') + ')</div>' +
      (E.perm.cargar && !EI ? '<div class="acciones" style="margin-bottom:6px"><button class="btn sec" onclick="IMP.itemsEditar(\'' + o.id + '\')">✎ Editar tabla</button>' +
        (o.proforma_path && /\.xlsx$/i.test(o.proforma_path) && (o.items || []).some(function (i) { return !i.foto_path; }) ?
          '<button class="btn sec" id="impFotosBtn" onclick="IMP.traerFotos(\'' + o.id + '\')">📷 Traer fotos de la proforma</button>' : '') + '</div>' : '') +
      tablaItems(o.items || [], p.moneda, { src: function (i) { return urls && urls[i.foto_path] || ''; }, editar: E.perm.cargar && !EI ? o.id : '', editando: !!EI }) +
      (EI ? '<div class="acciones" style="margin-top:8px"><button class="btn" onclick="IMP.itemsGuardar()">Guardar cambios</button><button class="btn sec" onclick="IMP.itemsFila()">＋ Fila</button><button class="btn sec" onclick="IMP.itemsCancelar()">Cancelar</button></div>' : '') +
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

  // ------------------------------------------------------------ cálculos (como las hojas de OP del Excel)
  var CA = null, BASES = { cif: 'CIF (FOB + flete + seguro)', fob: 'FOB (valor de la mercadería)', base_iva: 'CIF + derechos y tasas', manual: 'Monto fijo' };
  var GRUPOS = { financiero: 'Financiero', flete_seguro: 'Flete y seguro', impositivo: 'Impositivo', administrativo: 'Administrativo' };
  function r2(n) { return Math.round(n * 100) / 100; }
  function pct(n) { return (Math.round(n * 10000) / 100).toLocaleString('es-AR') + ' %'; }
  function calcular(c) {
    var items = c.o.items || [], fob = 0, q = 0, grupo = {}, res = { flete: 0, seguro: 0 };
    c.conceptos.forEach(function (k) { grupo[k.concepto] = k.grupo; });
    items.forEach(function (i) { fob += i.cantidad * i.precio_unit; q += Number(i.cantidad); });
    c.obl.forEach(function (x) { if (x.concepto === 'Flete') res.flete += Number(x.monto); if (x.concepto === 'Seguro') res.seguro += Number(x.monto); });
    var cif = fob + res.flete + res.seguro, derechos = 0;
    c.trib.forEach(function (t) { if (t.base_tipo === 'cif') { t._base = cif; t._monto = r2(cif * t.alicuota); derechos += t._monto; } });
    var baseIva = cif + derechos, costoT = 0, credT = 0;
    c.trib.forEach(function (t) {
      if (t.base_tipo === 'fob') t._base = fob; else if (t.base_tipo === 'base_iva') t._base = baseIva; else if (t.base_tipo === 'manual') t._base = Number(t.base_imponible);
      if (t.base_tipo !== 'cif') t._monto = r2(t._base * t.alicuota);
      if (t.es_credito) credT += t._monto; else costoT += t._monto;
    });
    var g = { financiero: 0, flete_seguro: 0, impositivo: costoT, administrativo: 0 }, cred = credT, gastos = costoT;
    c.obl.forEach(function (x) {
      if (x.concepto === 'Impuestos') return;
      var k = grupo[x.concepto]; if (!g.hasOwnProperty(k)) return;
      g[k] += Number(x.monto); gastos += Number(x.monto); cred += Number(x.credito_fiscal);
    });
    c.r = { fob: fob, q: q, cif: cif, baseIva: baseIva, costoT: costoT, credT: credT, g: g, gastos: gastos, cred: cred, total: fob + gastos,
            unit: q ? (fob + gastos) / q : 0, grupo: grupo };
  }
  /** Deja guardados los montos de tributos y la obligación «Impuestos» (la usa el resumen de pagos). */
  function sincronizar(c) {
    var p = [];
    c.trib.forEach(function (t) {
      if (t.base_tipo !== 'manual' && Math.abs(Number(t.base_imponible) - t._base) > 0.004) p.push(rest('tributos_operacion?id=eq.' + t.id, { metodo: 'PATCH', cuerpo: { base_imponible: r2(t._base) } }));
    });
    if (c.trib.length) {
      var im = c.obl.filter(function (x) { return x.concepto === 'Impuestos'; })[0];
      if (!im) p.push(rest('obligaciones', { metodo: 'POST', cuerpo: { operacion_id: c.o.id, concepto: 'Impuestos', moneda: (c.o.pedido || {}).moneda || 'USD', monto: r2(c.r.costoT), credito_fiscal: r2(c.r.credT) } }));
      else if (Math.abs(im.monto - c.r.costoT) > 0.004 || Math.abs(im.credito_fiscal - c.r.credT) > 0.004)
        p.push(rest('obligaciones?id=eq.' + im.id, { metodo: 'PATCH', cuerpo: { monto: r2(c.r.costoT), credito_fiscal: r2(c.r.credT) } }));
    }
    return Promise.all(p).catch(function () {});
  }
  function calculos(id) {
    $('hoja').innerHTML = '<div class="vacio">Calculando…</div>';
    var o = FI;
    Promise.all([rest('obligaciones?operacion_id=eq.' + id + '&anulada=is.false&order=concepto'), rest('tributos_operacion?operacion_id=eq.' + id + '&order=orden'),
                 rest('costos_conceptos?order=concepto')]).then(function (r) {
      CA = { id: id, o: o, obl: r[0], trib: r[1], conceptos: r[2] };
      calcular(CA);
      return sincronizar(CA);
    }).then(pintarCalculos).catch(function (e) { $('hoja').innerHTML = '<div class="vacio">' + esc(e.message || e) + '</div>'; });
  }
  function pintarCalculos() {
    var c = CA, o = c.o, r = c.r, mon = esc((o.pedido || {}).moneda || 'USD'), id = c.id;
    var vacio = !c.trib.length && !c.obl.length;
    var h = pestanas(id, 'calc') +
      '<h2>' + (o.op_numero ? 'OP ' + esc(o.op_numero) : esc((o.pedido || {}).codigo_interno)) + ' · cálculos</h2>';
    if (vacio) h += '<div class="ped-msg">Todavía no hay costos cargados. Podés empezar con los valores del modelo de tus hojas (derechos 20 %, tasa 3 %, IVA 21 %, honorarios del despachante…) y después cambiar lo que haga falta.</div>' +
      '<div class="acciones"><button class="btn" onclick="IMP.defaults(\'' + id + '\')">Cargar valores por defecto</button></div>';
    h += '<div class="sub">Resumen (' + mon + ')</div>' +
      fila('FOB (mercadería)', fmt(r.fob)) + fila('Flete + seguro', fmt(r.cif - r.fob)) + fila('CIF imponible', fmt(r.cif)) +
      fila('Total gastos (sin IVA/créditos)', fmt(r.gastos)) + fila('Costo total', fmt(r.total)) +
      fila('Costo unitario promedio', fmt(r.unit)) + fila('Recargo sobre FOB', r.fob ? pct(r.total / r.fob - 1) : '') +
      fila('Créditos fiscales', fmt(r.cred));
    var pg = 0; (o._pagos || []).forEach(function (x) { pg += Number(x.monto); });
    h += fila('Pagado al proveedor', fmt(pg)) + fila('Saldo con el proveedor', fmt(r.fob - pg));
    // tributos
    h += '<div class="sub">Tributos de importación</div>' + (TE ? '' : '<div class="acciones" style="margin-bottom:6px"><button class="btn sec" onclick="IMP.tribEditar()">✎ Editar tabla</button></div>') +
      (TE ? tablaTribEd() : '<div class="tabla-items"><table><thead><tr><th>Tributo</th><th>Base</th><th>%</th><th>Costo</th><th>Crédito</th><th></th></tr></thead><tbody>' +
      c.trib.map(function (t) {
        return '<tr><td class="d">' + esc(t.tributo) + '<div class="ped-sub">' + esc(BASES[t.base_tipo]) + '</div></td><td class="n">' + fmt(t._base) + '</td><td class="n">' + pct(t.alicuota) +
          '</td><td class="n">' + (t.es_credito ? '' : fmt(t._monto)) + '</td><td class="n">' + (t.es_credito ? fmt(t._monto) : '') +
          '</td><td></td></tr>'; }).join('') +
      '</tbody><tfoot><tr><td colspan="3">Total</td><td class="n">' + fmt(r.costoT) + '</td><td class="n">' + fmt(r.credT) + '</td><td></td></tr></tfoot></table></div>');
    // gastos
    var gastos = c.obl.filter(function (x) { return x.concepto !== 'Impuestos' && r.grupo[x.concepto] && r.grupo[x.concepto] !== 'proveedor'; });
    h += '<div class="sub">Gastos</div>' + (GE ? '' : '<div class="acciones" style="margin-bottom:6px"><button class="btn sec" onclick="IMP.gastEditar()">✎ Editar tabla</button></div>') +
      (GE ? tablaGastoEd() : '<div class="tabla-items"><table><thead><tr><th>Concepto</th><th>Grupo</th><th>Monto</th><th>IVA crédito</th><th></th></tr></thead><tbody>' +
      gastos.map(function (x) {
        return '<tr><td class="d">' + esc(x.concepto) + (x.vencimiento ? '<div class="ped-sub">vence ' + esc(fecha(x.vencimiento)) + '</div>' : '') + '</td><td>' + esc(GRUPOS[r.grupo[x.concepto]] || '') +
          '</td><td class="n">' + fmt(x.monto) + '</td><td class="n">' + fmt(x.credito_fiscal) + '</td><td></td></tr>'; }).join('') +
      '</tbody></table></div>');
    // costo por producto
    h += '<div class="sub">Costo por producto</div><div class="tabla-items"><table><thead><tr><th>#</th><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Financ.</th><th>Flete+seg.</th><th>Impos.</th><th>Adm.</th><th>Costo unit.</th><th>Costo total</th><th>%</th></tr></thead><tbody>' +
      (o.items || []).map(function (i) {
        var q = r.q || 1, f = r.g.financiero / q, fl = r.g.flete_seguro / q, im = r.g.impositivo / q, ad = r.g.administrativo / q, u = Number(i.precio_unit) + f + fl + im + ad;
        return '<tr><td class="c">' + esc(i.linea) + '</td><td class="d">' + esc(i.detalle) + '</td><td class="n">' + fmt0(i.cantidad) + '</td><td class="n">' + fmt(i.precio_unit) + '</td><td class="n">' + fmt(f) +
          '</td><td class="n">' + fmt(fl) + '</td><td class="n">' + fmt(im) + '</td><td class="n">' + fmt(ad) + '</td><td class="n"><b>' + fmt(u) + '</b></td><td class="n">' + fmt(u * i.cantidad) +
          '</td><td class="n">' + (i.precio_unit > 0 ? pct(u / i.precio_unit - 1) : '') + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
    // valor criterio
    var ref = Number(o.valor_criterio_unit || 0) * r.q, gar = ref ? ref - r.fob : 0;
    h += '<div class="sub">Valor criterio y caución</div>' + dato('cvCrit', 'Valor criterio por unidad (' + mon + ')', o.valor_criterio_unit, 'number') +
      dato('cvCau', 'Caución (' + mon + ')', o.caucion, 'number') +
      fila('Valor de referencia', ref ? fmt(ref) : '') + fila('Valor a garantizar', ref ? fmt(gar) : '') +
      '<div class="acciones" style="margin-top:8px"><button class="btn sec" onclick="IMP.guardarCriterio(\'' + id + '\')">Guardar criterio</button></div>' +
      '<div class="acciones" style="margin-top:14px"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>';
    $('hoja').innerHTML = h;
  }
  // ---- edición de tributos y gastos directamente en la tabla
  var TE = null, GE = null;
  function cp(x) { return JSON.parse(JSON.stringify(x)); }
  function tablaTribEd() {
    return '<div class="tabla-items"><table><thead><tr><th>Tributo</th><th>Se calcula sobre</th><th>Monto base</th><th>%</th><th>Tipo</th><th></th></tr></thead><tbody>' +
      TE.rows.map(function (t, k) {
        if (t._del) return '';
        return '<tr><td><input id="te' + k + 'n" value="' + esc(t.tributo) + '" class="cel" style="width:150px"></td><td><select id="te' + k + 'b" class="cel">' +
          Object.keys(BASES).map(function (b) { return '<option value="' + b + '"' + (b === t.base_tipo ? ' selected' : '') + '>' + esc(BASES[b]) + '</option>'; }).join('') + '</select></td>' +
          '<td class="n"><input id="te' + k + 'f" type="number" step="any" value="' + esc(t.base_imponible) + '" class="cel" style="width:80px"></td>' +
          '<td class="n"><input id="te' + k + 'p" type="number" step="any" value="' + Math.round(t.alicuota * 10000) / 100 + '" class="cel" style="width:64px"></td>' +
          '<td><select id="te' + k + 'c" class="cel"><option value="0"' + (t.es_credito ? '' : ' selected') + '>Costo</option><option value="1"' + (t.es_credito ? ' selected' : '') + '>Crédito</option></select></td>' +
          '<td><button class="chip" style="padding:2px 9px;color:#e5484d" onclick="IMP.tribQuitar(' + k + ')">✕</button></td></tr>'; }).join('') +
      '</tbody></table></div><div class="ped-sub">En «Monto fijo» poné el monto base y 100 de %. El monto base solo se usa en «Monto fijo».</div>' +
      '<div class="acciones" style="margin-top:8px"><button class="btn" onclick="IMP.tribGuardar()">Guardar cambios</button><button class="btn sec" onclick="IMP.tribFila()">＋ Fila</button><button class="btn sec" onclick="IMP.tribCancelar()">Cancelar</button></div>';
  }
  function tribEditar() { TE = { rows: cp(CA.trib) }; pintarCalculos(); }
  function leerTE() { TE.rows.forEach(function (t, k) { if (t._del) return; t.tributo = $('te' + k + 'n').value; t.base_tipo = $('te' + k + 'b').value; t.base_imponible = $('te' + k + 'f').value; t.alicuota = Number($('te' + k + 'p').value || 0) / 100; t.es_credito = $('te' + k + 'c').value === '1'; }); }
  function tribFila() { leerTE(); TE.rows.push({ tributo: '', base_tipo: 'base_iva', base_imponible: 0, alicuota: 0, es_credito: false }); pintarCalculos(); }
  function tribQuitar(k) { leerTE(); if (TE.rows[k].id) TE.rows[k]._del = true; else TE.rows.splice(k, 1); pintarCalculos(); }
  function tribCancelar() { TE = null; pintarCalculos(); }
  function tribGuardar() {
    leerTE(); var ps = [], mal = false, mx = 0, orig = {}; CA.trib.forEach(function (t) { orig[t.id] = t; if (t.orden > mx) mx = t.orden; });
    TE.rows.forEach(function (t) {
      if (t._del) { ps.push(rest('tributos_operacion?id=eq.' + t.id, { metodo: 'DELETE' })); return; }
      var c = { tributo: (t.tributo || '').trim(), base_tipo: t.base_tipo, base_imponible: Number(t.base_imponible || 0), alicuota: t.alicuota, es_credito: t.es_credito };
      if (!c.tributo) { mal = true; return; }
      if (!t.id) { c.operacion_id = CA.id; c.orden = ++mx; ps.push(rest('tributos_operacion', { metodo: 'POST', cuerpo: c })); return; }
      var x = orig[t.id];
      if (x.tributo !== c.tributo || x.base_tipo !== c.base_tipo || (c.base_tipo === 'manual' && Number(x.base_imponible) !== c.base_imponible) || Number(x.alicuota) !== c.alicuota || x.es_credito !== c.es_credito) {
        if (c.base_tipo !== 'manual') delete c.base_imponible;
        ps.push(rest('tributos_operacion?id=eq.' + t.id, { metodo: 'PATCH', cuerpo: c }));
      }
    });
    if (mal) { toast('Hay un tributo sin nombre'); return; }
    var n = ps.length; Promise.all(ps).then(function () { if (n) bitacora(CA.id, 'tributos editados', { cambios: n }); TE = null; toast(n ? 'Cambios guardados' : 'Sin cambios'); calculos(CA.id); }).catch(function (e) { toast(e.message || e); });
  }
  function tablaGastoEd() {
    var op = CA.conceptos.filter(function (k) { return k.concepto !== 'Impuestos' && GRUPOS[k.grupo]; });
    return '<div class="tabla-items"><table><thead><tr><th>Concepto</th><th>Monto</th><th>IVA crédito</th><th></th></tr></thead><tbody>' +
      GE.rows.map(function (x, k) {
        if (x._del) return '';
        return '<tr><td><select id="ge' + k + 'k" class="cel">' + op.map(function (c) { return '<option' + (c.concepto === x.concepto ? ' selected' : '') + '>' + esc(c.concepto) + '</option>'; }).join('') + '</select></td>' +
          '<td class="n"><input id="ge' + k + 'm" type="number" step="any" value="' + esc(x.monto) + '" class="cel" style="width:90px"></td>' +
          '<td class="n"><input id="ge' + k + 'c" type="number" step="any" placeholder="21 %" value="' + esc(x.credito_fiscal) + '" class="cel" style="width:80px"></td>' +
          '<td><button class="chip" style="padding:2px 9px;color:#e5484d" onclick="IMP.gastQuitar(' + k + ')">✕</button></td></tr>'; }).join('') +
      '</tbody></table></div><div class="ped-sub">Si dejás el IVA crédito vacío se calcula el 21 % del monto.</div>' +
      '<div class="acciones" style="margin-top:8px"><button class="btn" onclick="IMP.gastGuardar()">Guardar cambios</button><button class="btn sec" onclick="IMP.gastFila()">＋ Fila</button><button class="btn sec" onclick="IMP.gastCancelar()">Cancelar</button></div>';
  }
  function gastEditar() { GE = { rows: cp(CA.obl.filter(function (x) { return x.concepto !== 'Impuestos' && CA.r.grupo[x.concepto] && CA.r.grupo[x.concepto] !== 'proveedor'; })) }; pintarCalculos(); }
  function leerGE() { GE.rows.forEach(function (x, k) { if (x._del) return; x.concepto = $('ge' + k + 'k').value; x.monto = $('ge' + k + 'm').value; x.credito_fiscal = $('ge' + k + 'c').value; }); }
  function gastFila() { leerGE(); GE.rows.push({ concepto: 'SEDI', monto: '', credito_fiscal: '' }); pintarCalculos(); }
  function gastQuitar(k) { leerGE(); if (GE.rows[k].id) GE.rows[k]._del = true; else GE.rows.splice(k, 1); pintarCalculos(); }
  function gastCancelar() { GE = null; pintarCalculos(); }
  function gastGuardar() {
    leerGE(); var ps = [], mal = false, orig = {}; CA.obl.forEach(function (x) { orig[x.id] = x; });
    GE.rows.forEach(function (x) {
      if (x._del) { ps.push(rest('obligaciones?id=eq.' + x.id, { metodo: 'DELETE' })); return; }
      if (x.monto === '' || isNaN(Number(x.monto))) { mal = true; return; }
      var m = Number(x.monto), c = { concepto: x.concepto, monto: m, credito_fiscal: x.credito_fiscal === '' || x.credito_fiscal == null ? r2(m * 0.21) : Number(x.credito_fiscal) };
      if (!x.id) { c.operacion_id = CA.id; c.moneda = (CA.o.pedido || {}).moneda || 'USD'; ps.push(rest('obligaciones', { metodo: 'POST', cuerpo: c })); return; }
      var y = orig[x.id];
      if (y.concepto !== c.concepto || Number(y.monto) !== c.monto || Number(y.credito_fiscal) !== c.credito_fiscal) ps.push(rest('obligaciones?id=eq.' + x.id, { metodo: 'PATCH', cuerpo: c }));
    });
    if (mal) { toast('Cada gasto necesita un monto'); return; }
    var n = ps.length; Promise.all(ps).then(function () { if (n) bitacora(CA.id, 'gastos editados', { cambios: n }); GE = null; toast(n ? 'Cambios guardados' : 'Sin cambios'); calculos(CA.id); })
      .catch(function (e) { toast(/foreign|aplicaciones/i.test(e.message) ? 'Un gasto tiene pagos aplicados: no se puede sacar' : (e.message || e)); });
  }

  function defaults(id) {
    rest('rpc/cargar_defaults_calculo', { metodo: 'POST', cuerpo: { p_op: id } }).then(function () { bitacora(id, 'valores por defecto cargados'); toast('Valores cargados'); calculos(id); })
      .catch(function (e) { toast(e.message || e); });
  }
  function guardarCriterio(id) {
    var v = vv('cvCrit'), cau = vv('cvCau'), ref = Number(v || 0) * CA.r.q;
    rest('operaciones?id=eq.' + id, { metodo: 'PATCH', cuerpo: { valor_criterio_unit: v === '' ? null : Number(v), caucion: cau === '' ? null : Number(cau), valor_garantizar: v === '' ? null : r2(ref - CA.r.fob) } })
      .then(function () { FI.valor_criterio_unit = v === '' ? null : Number(v); FI.caucion = cau === '' ? null : Number(cau); toast('Guardado'); calculos(id); })
      .catch(function (e) { toast(e.message || e); });
  }
  function editarTributo(tid) {
    var t = CA.trib.filter(function (x) { return x.id === tid; })[0], nuevo = !t;
    if (nuevo) t = { tributo: '', base_tipo: 'base_iva', base_imponible: 0, alicuota: 0, es_credito: false };
    $('hoja').innerHTML = '<h2 class="vt">' + (nuevo ? 'Agregar tributo' : 'Editar tributo') + '</h2>' + dato('trNom', 'Tributo', t.tributo) +
      '<div class="sub">Se calcula sobre</div><select id="trBase">' + Object.keys(BASES).map(function (k) { return '<option value="' + k + '"' + (k === t.base_tipo ? ' selected' : '') + '>' + esc(BASES[k]) + '</option>'; }).join('') + '</select>' +
      dato('trFijo', 'Monto base (solo si es «Monto fijo»)', t.base_imponible, 'number') + dato('trPct', 'Alícuota (%) — en «Monto fijo» poné 100', Math.round(t.alicuota * 10000) / 100, 'number') +
      '<div class="sub">Tipo</div><select id="trCred"><option value="0"' + (t.es_credito ? '' : ' selected') + '>Costo (se paga y suma al costo)</option><option value="1"' + (t.es_credito ? ' selected' : '') + '>Crédito fiscal (se recupera)</option></select>' +
      '<div class="acciones" style="margin-top:14px"><button class="btn" onclick="IMP.guardarTributo(\'' + (nuevo ? '' : tid) + '\')">Guardar</button><button class="btn sec" onclick="IMP.calculos(\'' + CA.id + '\')">Cancelar</button>' +
      (nuevo ? '' : '<button class="btn sec" style="margin-left:auto;color:#e5484d" onclick="IMP.borrarTributo(\'' + tid + '\')">Sacar</button>') + '</div>';
  }
  function guardarTributo(tid) {
    var nom = vv('trNom'); if (!nom) { toast('Poné el nombre del tributo'); return; }
    var c = { tributo: nom, base_tipo: $('trBase').value, base_imponible: Number(vv('trFijo') || 0), alicuota: Number(vv('trPct') || 0) / 100, es_credito: $('trCred').value === '1' };
    var mx = 0; CA.trib.forEach(function (x) { if (x.orden > mx) mx = x.orden; });
    var q = tid ? rest('tributos_operacion?id=eq.' + tid, { metodo: 'PATCH', cuerpo: c }) : (c.operacion_id = CA.id, c.orden = mx + 1, rest('tributos_operacion', { metodo: 'POST', cuerpo: c }));
    q.then(function () { bitacora(CA.id, tid ? 'tributo editado' : 'tributo agregado', c); calculos(CA.id); }).catch(function (e) { toast(e.message || e); });
  }
  function borrarTributo(tid) {
    if (!confirm('¿Sacar este tributo?')) return;
    rest('tributos_operacion?id=eq.' + tid, { metodo: 'DELETE' }).then(function () { bitacora(CA.id, 'tributo quitado', { id: tid }); calculos(CA.id); }).catch(function (e) { toast(e.message || e); });
  }
  function editarGasto(gid) {
    var x = CA.obl.filter(function (y) { return y.id === gid; })[0], nuevo = !x;
    if (nuevo) x = { concepto: '', monto: '', credito_fiscal: '', vencimiento: '' };
    var op = CA.conceptos.filter(function (k) { return k.concepto !== 'Impuestos' && GRUPOS[k.grupo]; });
    $('hoja').innerHTML = '<h2 class="vt">' + (nuevo ? 'Agregar gasto' : 'Editar gasto') + '</h2><div class="sub">Concepto</div><select id="gsCon">' +
      op.map(function (k) { return '<option' + (k.concepto === x.concepto ? ' selected' : '') + '>' + esc(k.concepto) + '</option>'; }).join('') + '</select>' +
      dato('gsMon', 'Monto sin IVA', x.monto, 'number') + dato('gsCre', 'IVA crédito fiscal (vacío = 21 % del monto)', x.credito_fiscal, 'number') + dato('gsVen', 'Vencimiento (opcional)', x.vencimiento, 'date') +
      '<div class="acciones" style="margin-top:14px"><button class="btn" onclick="IMP.guardarGasto(\'' + (nuevo ? '' : gid) + '\')">Guardar</button><button class="btn sec" onclick="IMP.calculos(\'' + CA.id + '\')">Cancelar</button>' +
      (nuevo ? '' : '<button class="btn sec" style="margin-left:auto;color:#e5484d" onclick="IMP.borrarGasto(\'' + gid + '\')">Sacar</button>') + '</div>';
  }
  function guardarGasto(gid) {
    if (vv('gsMon') === '') { toast('Poné el monto'); return; }
    var m = Number(vv('gsMon')), c = { concepto: $('gsCon').value, monto: m, credito_fiscal: vv('gsCre') === '' ? r2(m * 0.21) : Number(vv('gsCre')), vencimiento: nul(vv('gsVen')) };
    var q = gid ? rest('obligaciones?id=eq.' + gid, { metodo: 'PATCH', cuerpo: c }) : (c.operacion_id = CA.id, c.moneda = (CA.o.pedido || {}).moneda || 'USD', rest('obligaciones', { metodo: 'POST', cuerpo: c }));
    q.then(function () { bitacora(CA.id, gid ? 'gasto editado' : 'gasto agregado', c); calculos(CA.id); }).catch(function (e) { toast(e.message || e); });
  }
  function borrarGasto(gid) {
    if (!confirm('¿Sacar este gasto?')) return;
    rest('obligaciones?id=eq.' + gid, { metodo: 'DELETE' }).then(function () { bitacora(CA.id, 'gasto quitado', { id: gid }); calculos(CA.id); })
      .catch(function (e) { toast(/foreign|aplicaciones/i.test(e.message) ? 'Tiene pagos aplicados: no se puede sacar' : e.message); });
  }

  /** Saca las fotos del Excel original que quedó guardado y se las pone a los productos que no tienen. */
  var traerBusy = false;
  function traerFotos(opId) {
    if (traerBusy) return; traerBusy = true;
    var b = $('impFotosBtn'), dir = FI.proforma_path.replace(/[^\/]+$/, ''), msg = function (t) { if (b) b.textContent = t; };
    msg('Descargando la proforma…');
    firmar([FI.proforma_path]).then(function (m) {
      var u = m[FI.proforma_path]; if (!u) throw new Error('No pude abrir la proforma guardada');
      return fetch(u).then(function (r) { if (!r.ok) throw new Error('No pude descargar la proforma'); return r.arrayBuffer(); });
    }).then(function (buf) {
      msg('Buscando las fotos…');
      return Proforma.leerProforma(buf).then(function (d) { return Proforma.fotos(buf, d.items); });
    }).then(function (fs) {
      var porLinea = {}; (FI.items || []).forEach(function (i) { if (!i.foto_path) porLinea[i.linea] = i; });
      var lista = fs.filter(function (x) { return porLinea[x.linea]; }), hechas = 0, falla = 0;
      if (!lista.length) throw new Error('No encontré fotos para estos productos');
      function una() {
        var x = lista.shift(); if (!x) return Promise.resolve();
        var it = porLinea[x.linea], ruta = dir + 'fotos/' + x.linea + '.jpg';
        return achicar(new Blob([x.bytes]), 560).then(function (bl) { return subir(ruta, bl, 'image/jpeg'); })
          .then(function () { return rest('operacion_items?id=eq.' + it.id, { metodo: 'PATCH', cuerpo: { foto_path: ruta } }); })
          .then(function () { msg('Subiendo fotos (' + (++hechas) + ')…'); }).catch(function () { falla++; }).then(una);
      }
      return Promise.all([una(), una(), una(), una()]).then(function () { return [hechas, falla]; });
    }).then(function (r) { traerBusy = false; toast(r[0] + ' fotos cargadas' + (r[1] ? ' · ' + r[1] + ' fallaron' : '')); ficha(opId); })
      .catch(function (e) { traerBusy = false; msg('📷 Traer fotos de la proforma'); toast(e.message || e); });
  }

  // ------------------------------------------------------------ pestañas y archivos de Drive
  function pestanas(id, act) {
    function t(k, txt, fn) { return '<span class="chip' + (k === act ? ' act' : '') + '"' + (k === act ? '' : ' onclick="IMP.' + fn + '(\'' + id + '\')"') + '>' + txt + '</span>'; }
    return '<div class="chips">' + t('op', 'Operación', 'ficha') + t('arch', 'Archivos', 'archivos') + (E.perm.dinero ? t('calc', 'Cálculos', 'calculos') : '') + '</div>';
  }
  function icono(m) {
    m = String(m || '');
    return /pdf/.test(m) ? '📕' : /image/.test(m) ? '🖼️' : /sheet|excel|csv/.test(m) ? '📗' : /word|document|text/.test(m) ? '📘' : /zip|compressed/.test(m) ? '🗜️' : /folder/.test(m) ? '📁' : '📄';
  }
  function tam(b) { b = Number(b || 0); return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b ? b + ' B' : ''; }
  function archivos(id) {
    var o = FI;
    $('hoja').innerHTML = '<div class="vacio">Cargando archivos…</div>';
    rest('documentos?operacion_id=eq.' + id + '&select=id,tipo,nombre,drive_url,carpeta,mime,modificado_en,tamano&order=carpeta.asc.nullsfirst,nombre.asc').then(function (l) {
      var grupos = {}, orden = [];
      l.forEach(function (x) { var k = x.carpeta || ''; if (!grupos[k]) { grupos[k] = []; orden.push(k); } grupos[k].push(x); });
      var h = pestanas(id, 'arch') + '<h2>' + (o.op_numero ? 'OP ' + esc(o.op_numero) : esc((o.pedido || {}).codigo_interno)) + ((o.pedido || {}).proveedor ? ' · ' + esc(o.pedido.proveedor.nombre) : '') + ' · archivos</h2>';
      if (o.drive_folder_url) h += '<div class="acciones"><a class="btn sec" style="text-decoration:none;text-align:center" href="' + esc(o.drive_folder_url) + '" target="_blank" rel="noopener">📁 Abrir la carpeta en Drive</a></div>' +
        '<div class="ped-sub">' + (o.drive_sync_en ? 'Actualizado el ' + esc(new Date(o.drive_sync_en).toLocaleString('es-AR')) + ' · se actualiza solo cada 15 minutos.' : '') + '</div>';
      if (!l.length) h += '<div class="ped-msg">' + (o.drive_folder_url ? 'La carpeta todavía no tiene archivos, o todavía no se actualizó el listado.' :
        (o.op_numero ? 'Todavía no se encontró la carpeta de esta operación en Drive. Aparece sola cuando exista una carpeta con el N° ' + esc(o.op_numero) + ' en el nombre.' :
        'Esta operación todavía no tiene N° de OP: cuando lo tenga, se busca su carpeta en Drive.')) + '</div>';
      orden.forEach(function (k) {
        h += '<div class="sub">' + (k ? '📁 ' + esc(k) : 'Carpeta principal') + ' (' + grupos[k].length + ')</div>' + grupos[k].map(function (x) {
          return '<a href="' + esc(x.drive_url) + '" target="_blank" rel="noopener" style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);color:inherit;text-decoration:none">' +
            '<span style="font-size:22px">' + icono(x.mime) + '</span><span style="flex:1;min-width:0"><span style="display:block;word-break:break-word">' + esc(x.nombre) + '</span>' +
            '<span class="ped-sub" style="display:block">' + (x.modificado_en ? esc(new Date(x.modificado_en).toLocaleDateString('es-AR')) : '') + (x.tamano ? ' · ' + tam(x.tamano) : '') + '</span></span></a>';
        }).join('');
      });
      h += '<div class="acciones" style="margin-top:14px"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>';
      $('hoja').innerHTML = h;
    }).catch(function (e) { $('hoja').innerHTML = '<div class="vacio">' + esc(e.message || e) + '</div>'; });
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
    var o = op || {}, ed = !!(o.editando && EI), u = 0, t = 0, filas;
    if (ed) {
      filas = EI.rows.map(function (i, k) {
        if (i._del) return '';
        var imp = Math.round(Number(i.cantidad || 0) * Number(i.precio_unit || 0) * 100) / 100; u += Number(i.cantidad || 0); t += imp;
        var src = i.id && o.src ? o.src(i) : '';
        return '<tr><td class="c"><input id="ei' + k + 'l" type="number" value="' + esc(i.linea) + '" class="cel" style="width:44px"></td>' +
          '<td class="f">' + (src ? '<img src="' + src + '" class="mini">' : '') + '</td>' +
          '<td><input id="ei' + k + 'c" value="' + esc(i.codigo || '') + '" class="cel" style="width:90px"></td>' +
          '<td class="d"><input id="ei' + k + 'd" value="' + esc(i.detalle || '') + '" class="cel" style="width:190px"></td>' +
          '<td class="n"><input id="ei' + k + 'q" type="number" value="' + esc(i.cantidad) + '" class="cel" style="width:70px"></td>' +
          '<td class="n"><input id="ei' + k + 'p" type="number" step="any" value="' + esc(i.precio_unit) + '" class="cel" style="width:80px"></td>' +
          '<td class="n">' + fmt(imp) + '</td><td><button class="chip" style="padding:2px 9px;color:#e5484d" onclick="IMP.itemsQuitar(' + k + ')">✕</button></td></tr>';
      }).join('');
    } else filas = items.map(function (i) {
      var imp = Math.round(i.cantidad * i.precio_unit * 100) / 100; u += Number(i.cantidad); t += imp;
      var src = o.src ? o.src(i) : '', foto = src
        ? '<img src="' + src + '" class="mini" onclick="IMP.ver(this.src)">'
        : (o.editar && i.id ? '<button class="mini vacia" onclick="IMP.elegirFoto(\'' + i.id + '\',\'' + o.editar + '\')">＋</button>' : '');
      if (src && o.editar && i.id) foto += '<div><button class="chip" style="padding:1px 8px;font-size:11px" onclick="IMP.elegirFoto(\'' + i.id + '\',\'' + o.editar + '\')">cambiar</button></div>';
      return '<tr><td class="c">' + esc(i.linea) + '</td><td class="f">' + foto + '</td><td>' + esc(i.codigo || '') + '</td><td class="d">' + esc(i.detalle) +
             '</td><td class="n">' + fmt0(i.cantidad) + '</td><td class="n">' + fmt(i.precio_unit) + '</td><td class="n">' + fmt(imp) + '</td></tr>';
    }).join('');
    return '<div class="tabla-items"><table><thead><tr><th>#</th><th>Foto</th><th>Código</th><th>Descripción</th><th>Cant.</th><th>Precio ' + esc(moneda || 'USD') +
           '</th><th>Importe</th>' + (ed ? '<th></th>' : '') + '</tr></thead><tbody>' + filas + '</tbody><tfoot><tr><td colspan="4">Total</td><td class="n">' + fmt0(u) +
           '</td><td></td><td class="n">' + fmt(t) + '</td>' + (ed ? '<td></td>' : '') + '</tr></tfoot></table></div>';
  }
  // ---- edición de productos directamente en la tabla
  var EI = null, LAST = null;
  function repintar() { pintarFicha.apply(null, LAST); }
  function itemsEditar(opId) { EI = { op: opId, rows: (FI.items || []).map(function (x) { return JSON.parse(JSON.stringify(x)); }) }; repintar(); }
  function leerEI() { EI.rows.forEach(function (r, k) { if (r._del) return; r.linea = $('ei' + k + 'l').value; r.codigo = $('ei' + k + 'c').value; r.detalle = $('ei' + k + 'd').value; r.cantidad = $('ei' + k + 'q').value; r.precio_unit = $('ei' + k + 'p').value; }); }
  function itemsFila() { leerEI(); var mx = 0; EI.rows.forEach(function (r) { if (!r._del && Number(r.linea) > mx) mx = Number(r.linea); }); EI.rows.push({ linea: mx + 1, codigo: '', detalle: '', cantidad: '', precio_unit: '' }); repintar(); }
  function itemsQuitar(k) { leerEI(); if (EI.rows[k].id) EI.rows[k]._del = true; else EI.rows.splice(k, 1); repintar(); }
  function itemsCancelar() { EI = null; repintar(); }
  function itemsGuardar() {
    leerEI();
    var orig = {}, ps = [], mal = false; (FI.items || []).forEach(function (x) { orig[x.id] = x; });
    EI.rows.forEach(function (r) {
      if (r._del) { ps.push(rest('operacion_items?id=eq.' + r.id, { metodo: 'DELETE' })); return; }
      var c = { linea: Number(r.linea), codigo: (r.codigo || '').trim() || null, detalle: (r.detalle || '').trim(), cantidad: Number(r.cantidad), precio_unit: Number(r.precio_unit) };
      if (!c.detalle || !(c.linea > 0) || r.cantidad === '' || r.precio_unit === '' || isNaN(c.cantidad) || isNaN(c.precio_unit)) { mal = true; return; }
      if (!r.id) { c.operacion_id = EI.op; ps.push(rest('operacion_items', { metodo: 'POST', cuerpo: c })); return; }
      var x = orig[r.id];
      if (x.linea !== c.linea || (x.codigo || null) !== c.codigo || x.detalle !== c.detalle || Number(x.cantidad) !== c.cantidad || Number(x.precio_unit) !== c.precio_unit)
        ps.push(rest('operacion_items?id=eq.' + r.id, { metodo: 'PATCH', cuerpo: c }));
    });
    if (mal) { toast('Cada producto necesita línea, descripción, cantidad y precio'); return; }
    var op = EI.op, n = ps.length;
    Promise.all(ps).then(function () { if (n) bitacora(op, 'productos editados', { cambios: n }); EI = null; toast(n ? 'Cambios guardados' : 'Sin cambios'); ficha(op); })
      .catch(function (e) { toast(e.message || e); });
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

  /** Elimina una operación (solo admin). La base guarda una copia en «operaciones_eliminadas». */
  function eliminar(id) {
    var o = (E.ops || []).filter(function (x) { return x.id === id; })[0] || {}, nom = o.op_numero ? 'OP ' + o.op_numero : ((o.pedido || {}).codigo_interno || 'esta operación');
    if (!confirm('¿Eliminar ' + nom + '? Se borran sus productos, pagos, costos y archivos asociados de la base. Esta acción no se puede deshacer desde la app.')) return;
    rest('rpc/eliminar_operacion', { metodo: 'POST', cuerpo: { p_op: id } })
      .then(function () { toast('Operación eliminada'); abrir(); })
      .catch(function (e) { toast(e.message || e); });
  }

  // ------------------------------------------------------------ pagos al proveedor
  function editarPago(opId, pid) {
    var x = (FI._pagos || []).filter(function (y) { return y.id === pid; })[0], nuevo = !x;
    if (nuevo) x = { concepto: FI._pagos.length ? 'Pago' : 'Seña', fecha: new Date().toISOString().slice(0, 10), monto: '', comentario: '' };
    $('hoja').innerHTML = '<h2 class="vt">' + (nuevo ? 'Registrar pago al proveedor' : 'Editar pago') + '</h2><div class="sub">Tipo</div><select id="pgCon">' +
      ['Seña', 'Pago', 'Saldo'].map(function (k) { return '<option' + (k === x.concepto ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>' +
      dato('pgFec', 'Fecha del pago', x.fecha, 'date') + dato('pgMon', 'Monto (' + esc((FI.pedido || {}).moneda || 'USD') + ')', x.monto, 'number') + dato('pgCom', 'Comentario', x.comentario) +
      '<div class="acciones" style="margin-top:14px"><button class="btn" onclick="IMP.guardarPago(\'' + opId + '\',\'' + (nuevo ? '' : pid) + '\')">Guardar</button><button class="btn sec" onclick="IMP.ficha(\'' + opId + '\')">Cancelar</button>' +
      (nuevo ? '' : '<button class="btn sec" style="margin-left:auto;color:#e5484d" onclick="IMP.borrarPago(\'' + opId + '\',\'' + pid + '\')">Sacar</button>') + '</div>';
  }
  function guardarPago(opId, pid) {
    var m = Number(vv('pgMon')); if (!(m > 0) || !vv('pgFec')) { toast('Poné fecha y un monto mayor a cero'); return; }
    var c = { concepto: $('pgCon').value, fecha: vv('pgFec'), monto: m, comentario: nul(vv('pgCom')) };
    var q = pid ? rest('pagos_operacion?id=eq.' + pid, { metodo: 'PATCH', cuerpo: c })
                : (c.operacion_id = opId, c.moneda = (FI.pedido || {}).moneda || 'USD', c.creado_por = ses && ses.uid, rest('pagos_operacion', { metodo: 'POST', cuerpo: c }));
    q.then(function () { bitacora(opId, pid ? 'pago editado' : 'pago registrado', c); toast('Pago guardado'); ficha(opId); }).catch(function (e) { toast(e.message || e); });
  }
  function borrarPago(opId, pid) {
    if (!confirm('¿Sacar este pago?')) return;
    rest('pagos_operacion?id=eq.' + pid, { metodo: 'DELETE' }).then(function () { bitacora(opId, 'pago quitado', { id: pid }); ficha(opId); }).catch(function (e) { toast(e.message || e); });
  }

  // ------------------------------------------------------------ valores por defecto del cálculo (admin)
  var DEF = null;
  function valoresDefecto() {
    Promise.all([rest('tributos_default?order=orden'), rest('gastos_default?order=orden'), rest('costos_conceptos?order=concepto')]).then(function (r) {
      DEF = { t: r[0], g: r[1], c: r[2].filter(function (k) { return k.concepto !== 'Impuestos' && GRUPOS[k.grupo]; }) };
      pintarDef();
      $('velo').style.display = 'block'; requestAnimationFrame(function () { $('hoja').className = 'hoja abierta'; });
    }).catch(function (e) { toast(e.message || e); });
  }
  function leerDef() {
    DEF.t.forEach(function (t, i) { t.tributo = $('dt' + i + 'n').value; t.base_tipo = $('dt' + i + 'b').value; t.base_fija = $('dt' + i + 'f').value === '' ? null : Number($('dt' + i + 'f').value);
      t.alicuota = Number($('dt' + i + 'p').value || 0) / 100; t.es_credito = $('dt' + i + 'c').value === '1'; });
    DEF.g.forEach(function (g, i) { g.concepto = $('dg' + i + 'k').value; g.monto = Number($('dg' + i + 'm').value || 0); g.credito_pct = Number($('dg' + i + 'c').value || 0) / 100; });
  }
  function pintarDef() {
    var h = '<h2 class="vt">Valores por defecto de cálculos</h2><div class="ped-msg">Se usan al tocar «Cargar valores por defecto» en una operación nueva. Las operaciones que ya los cargaron no cambian.</div><div class="sub">Tributos</div>' +
      DEF.t.map(function (t, i) {
        return '<div style="border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px"><input id="dt' + i + 'n" value="' + esc(t.tributo) + '" style="width:100%">' +
          '<select id="dt' + i + 'b" style="width:100%;margin-top:4px">' + Object.keys(BASES).map(function (k) { return '<option value="' + k + '"' + (k === t.base_tipo ? ' selected' : '') + '>' + esc(BASES[k]) + '</option>'; }).join('') + '</select>' +
          '<div style="display:flex;gap:6px;margin-top:4px"><input id="dt' + i + 'f" type="number" placeholder="monto base" value="' + (t.base_fija == null ? '' : t.base_fija) + '" style="flex:1;min-width:0">' +
          '<input id="dt' + i + 'p" type="number" placeholder="%" value="' + Math.round(t.alicuota * 10000) / 100 + '" style="flex:1;min-width:0"></div>' +
          '<select id="dt' + i + 'c" style="width:100%;margin-top:4px"><option value="0"' + (t.es_credito ? '' : ' selected') + '>Costo</option><option value="1"' + (t.es_credito ? ' selected' : '') + '>Crédito fiscal</option></select>' +
          '<button class="chip" style="margin-top:6px;color:#e5484d" onclick="IMP.quitarDef(\'t\',' + i + ')">Sacar</button></div>'; }).join('') +
      '<div class="acciones"><button class="btn sec" onclick="IMP.agregarDef(\'t\')">＋ Tributo</button></div><div class="sub">Gastos</div>' +
      DEF.g.map(function (g, i) {
        return '<div style="border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px"><select id="dg' + i + 'k" style="width:100%">' +
          DEF.c.map(function (k) { return '<option' + (k.concepto === g.concepto ? ' selected' : '') + '>' + esc(k.concepto) + '</option>'; }).join('') + '</select>' +
          '<div style="display:flex;gap:6px;margin-top:4px"><input id="dg' + i + 'm" type="number" placeholder="monto" value="' + g.monto + '" style="flex:1;min-width:0">' +
          '<input id="dg' + i + 'c" type="number" placeholder="% IVA" value="' + Math.round(g.credito_pct * 10000) / 100 + '" style="flex:1;min-width:0"></div>' +
          '<button class="chip" style="margin-top:6px;color:#e5484d" onclick="IMP.quitarDef(\'g\',' + i + ')">Sacar</button></div>'; }).join('') +
      '<div class="acciones"><button class="btn sec" onclick="IMP.agregarDef(\'g\')">＋ Gasto</button></div>' +
      '<div class="acciones" style="margin-top:14px"><button class="btn" onclick="IMP.guardarDef()">Guardar</button><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>';
    $('hoja').innerHTML = h;
  }
  function agregarDef(k) {
    leerDef();
    if (k === 't') DEF.t.push({ tributo: 'Nuevo tributo', base_tipo: 'base_iva', base_fija: null, alicuota: 0, es_credito: false });
    else DEF.g.push({ concepto: DEF.c[0].concepto, monto: 0, credito_pct: 0.21 });
    pintarDef();
  }
  function quitarDef(k, i) { leerDef(); DEF[k].splice(i, 1); pintarDef(); }
  /** Reemplaza las plantillas completas (son pocas filas): borra y vuelve a cargar con el orden de la pantalla. */
  function guardarDef() {
    leerDef();
    var t = DEF.t.map(function (x, i) { return { orden: i + 1, tributo: x.tributo, base_tipo: x.base_tipo, base_fija: x.base_tipo === 'manual' ? x.base_fija : null, alicuota: x.alicuota, es_credito: x.es_credito }; });
    var g = DEF.g.map(function (x, i) { return { orden: i + 1, concepto: x.concepto, monto: x.monto, credito_pct: x.credito_pct }; });
    if (t.some(function (x) { return !x.tributo; })) { toast('Hay un tributo sin nombre'); return; }
    rest('tributos_default?orden=gt.0', { metodo: 'DELETE' }).then(function () { return rest('gastos_default?orden=gt.0', { metodo: 'DELETE' }); })
      .then(function () { return t.length ? rest('tributos_default', { metodo: 'POST', cuerpo: t }) : null; })
      .then(function () { return g.length ? rest('gastos_default', { metodo: 'POST', cuerpo: g }) : null; })
      .then(function () { toast('Valores por defecto guardados'); cerrarHoja(); }).catch(function (e) { toast(e.message || e); });
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
  var RE_MAIL = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)*\.[A-Za-z]{2,}$/;
  function mails(t) { return String(t || '').split(/[\s,;]+/).filter(function (m) { return m; }); }
  function guardarDespachante(id) {
    var malas = mails($('dsPara').value).concat(mails($('dsCc').value)).filter(function (m) { return !RE_MAIL.test(m); });
    if (malas.length) { toast('Revisá estas direcciones: ' + malas.join(', ')); return; }
    rest('despachantes?id=eq.' + id, { metodo: 'PATCH', cuerpo: { destinatarios: mails($('dsPara').value), copia: mails($('dsCc').value),
      asunto_plantilla: $('dsAsu').value, cuerpo_plantilla: $('dsCue').value, envio_activo: $('dsAct').checked } })
      .then(function () { toast('Guardado'); cerrarHoja(); }).catch(function (e) { toast(e.message); });
  }

  return { login: login, iniciar: iniciar, salir: salir, abrir: abrir, filtrar: filtrar, buscar: buscar,
           ficha: ficha, estado: estado, guardarOp: guardarOp, nueva: nueva, leerArchivo: leerArchivo, editarPago: editarPago, guardarPago: guardarPago, borrarPago: borrarPago, valoresDefecto: valoresDefecto, agregarDef: agregarDef, quitarDef: quitarDef, guardarDef: guardarDef, itemsEditar: itemsEditar, itemsGuardar: itemsGuardar, itemsFila: itemsFila, itemsQuitar: itemsQuitar, itemsCancelar: itemsCancelar, tribEditar: tribEditar, tribGuardar: tribGuardar, tribFila: tribFila, tribQuitar: tribQuitar, tribCancelar: tribCancelar, gastEditar: gastEditar, gastGuardar: gastGuardar, gastFila: gastFila, gastQuitar: gastQuitar, gastCancelar: gastCancelar, calculos: calculos, defaults: defaults, guardarCriterio: guardarCriterio, editarTributo: editarTributo, guardarTributo: guardarTributo, borrarTributo: borrarTributo, editarGasto: editarGasto, guardarGasto: guardarGasto, borrarGasto: borrarGasto, editarDatos: editarDatos, guardarDatos: guardarDatos, editarItem: editarItem, guardarItem: guardarItem, borrarItem: borrarItem, ver: ver, eliminar: eliminar, traerFotos: traerFotos, archivos: archivos, elegirFoto: elegirFoto,
           confirmar: confirmar, despachante: despachante, guardarDespachante: guardarDespachante, pedirMail: pedirMail };
})();
