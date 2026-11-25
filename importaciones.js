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

  function subir(ruta, bytes) {
    return acceso().then(function (tok) {
      return fetch(CONFIG.supabase_url + '/storage/v1/object/proformas/' + ruta, { method: 'POST',
        headers: { apikey: CONFIG.supabase_key, Authorization: 'Bearer ' + tok, 'x-upsert': 'false',
                   'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: bytes });
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
      'items:operacion_items(linea,codigo,detalle,cantidad,precio_unit)')];
    if (E.perm.dinero) pedidos.push(rest('v_pagos_operacion?operacion_id=eq.' + id));
    Promise.all(pedidos).then(function (r) { pintarFicha(r[0][0], r[1] || []); })
      .catch(function (e) { $('hoja').innerHTML = '<div class="vacio">' + esc(e.message) + '</div>'; });
  }
  var BLOQ = { proveedor: 'Proveedor', logistica: 'Logística', nacionalizacion: 'Nacionalización' };
  function pintarFicha(o, pagos) {
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
      fila('Despachante', (o.despachante || {}).nombre) + fila('Transporte', o.transporte) +
      fila('ETD', o.etd ? fecha(o.etd) : '') + fila('ETA', o.eta ? fecha(o.eta) : '') +
      ((o.unif || []).length ? fila('OP unificadas', o.unif.map(function (u) { return u.op_numero; }).join(', ')) : '');
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
      '<details><summary class="ped-sub">Ver detalle</summary>' + (o.items || []).map(function (i) {
        return '<div class="ped-sub">' + esc(i.linea) + '. ' + esc(i.codigo ? i.codigo + ' · ' : '') + esc(i.detalle) +
               ' — ' + fmt(i.cantidad) + ' × ' + fmt(i.precio_unit) + '</div>';
      }).join('') + '</details>' +
      '<div class="acciones" style="margin-top:14px"><button class="btn sec" onclick="cerrarHoja()">Cerrar</button></div>';
    $('hoja').innerHTML = h;
  }
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
      '<div class="ped-sub">Subí la proforma en Excel. Vas a revisar los datos antes de confirmar.</div>' +
      '<input type="file" id="impArch" accept=".xlsx" onchange="IMP.leerArchivo(this)" style="margin-top:12px">' +
      '<div class="ped-msg" id="impMsg"></div>' +
      '<div class="acciones" style="margin-top:12px"><button class="btn sec" onclick="IMP.abrir()">Volver</button></div>';
  }
  function leerArchivo(inp) {
    var f = inp.files && inp.files[0]; if (!f) return;
    $('impMsg').textContent = 'Leyendo la proforma…';
    Promise.all([f.arrayBuffer(), Promise.all([
      rest('importadores?select=id,nombre&activo=eq.true&order=nombre'), rest('proveedores?select=id,nombre&order=nombre'),
      rest('traders?select=id,nombre&order=nombre'),
      rest('despachantes?select=id,nombre,destinatarios,copia,envio_activo,asunto_plantilla,cuerpo_plantilla&order=nombre')])])
      .then(function (r) {
        ALTA = { buf: new Uint8Array(r[0]), nombre: f.name, imp: r[1][0], prov: r[1][1], tr: r[1][2], desp: r[1][3] };
        return Proforma.leerProforma(ALTA.buf);
      }).then(function (d) { ALTA.d = d; formulario(); })
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
      '<div class="ped-msg">' + d.items.length + ' productos · ' + fmt(d.unidades) + ' unidades · total ' + fmt(d.total_calculado) + ' USD' +
      (d.coincide_total === true ? ' ✔ coincide con el total del documento' :
       d.coincide_total === false ? ' ⚠ el documento dice ' + fmt(d.total_documento) + ': revisalo' : '') + '</div>' +
      '<div class="sub">Importador (comprador)</div><select id="impImp">' + opciones(ALTA.imp, d.comprador, d.comprador) + '</select>' +
      '<div class="sub">Proveedor (vendedor)</div><select id="impProv">' + opciones(ALTA.prov, d.vendedor, d.vendedor) + '</select>' +
      '<div class="sub">Trader (si hay)</div><select id="impTr">' + opciones(ALTA.tr, '', '', true) + '</select>' +
      campo('impProd', 'Producto', resumenProducto(d.items)) + campo('impPc', 'Puerto de carga', d.puerto_carga) +
      campo('impPd', 'Puerto de destino', d.puerto_destino) + campo('impPago', 'Forma de pago', d.pago) +
      campo('impFec', 'Fecha de la proforma (AAAA-MM-DD)', d.fecha) + campo('impCom', 'Comentario', '') +
      '<details style="margin-top:10px"><summary class="ped-sub">Ver los productos</summary>' + d.items.map(function (i) {
        return '<div class="ped-sub">' + i.linea + '. ' + esc(i.codigo) + ' · ' + esc(i.detalle) + ' — ' + fmt(i.cantidad) + ' × ' + fmt(i.precio_unit) + '</div>'; }).join('') + '</details>' +
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
      '<div class="ped-sub"><b>Adjunto:</b> proforma sin fotos + link a la original en Drive</div>' +
      '<div class="ped-msg">' + (ds.envio_activo ? 'Al confirmar, el mail sale solo.' : 'El envío está desactivado: NO se manda ningún mail. Se puede enviar después desde la ficha.') + '</div>';
  }
  function confirmar(btn) {
    var d = ALTA.d, ds = ALTA.desp[0] || {}, msg = $('impMsg');
    var imp = $('impImp').value, prov = $('impProv').value;
    if (!$('impProd').value.trim()) { msg.textContent = 'Falta el producto'; return; }
    btn.disabled = true; msg.textContent = 'Subiendo la proforma…';
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
        base = new Date().getFullYear() + '/' + id + '/', pOrig = base + 'proforma.xlsx', pLite = base + 'proforma-sin-fotos.xlsx';
    Proforma.aliviar(ALTA.buf)
      .then(function (lite) { return subir(pOrig, ALTA.buf).then(function () { return subir(pLite, lite); }); })
      .then(function () {
        msg.textContent = 'Creando el pedido y la operación…';
        return rest('rpc/alta_operacion', { metodo: 'POST', cuerpo: { p: {
          importador_id: imp === '__nuevo' ? '' : imp, importador_nuevo: imp === '__nuevo' ? d.comprador : '',
          proveedor_id: prov === '__nuevo' ? '' : prov, proveedor_nuevo: prov === '__nuevo' ? d.vendedor : '',
          trader_id: $('impTr').value, producto: $('impProd').value.trim(), forma_pago: $('impPago').value.trim(),
          puerto_carga: $('impPc').value.trim(), puerto_destino: $('impPd').value.trim(), fecha_proforma: $('impFec').value.trim(),
          comentario: $('impCom').value.trim(), despachante_id: ds.id, proforma_path: pOrig, proforma_liviana_path: pLite,
          enviar_mail: !!ds.envio_activo, items: d.items.map(function (i) {
            return { linea: i.linea, codigo: i.codigo, detalle: i.detalle, cantidad: i.cantidad, precio_unit: i.precio_unit }; }) } } });
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
           ficha: ficha, estado: estado, guardarOp: guardarOp, nueva: nueva, leerArchivo: leerArchivo,
           confirmar: confirmar, despachante: despachante, guardarDespachante: guardarDespachante, pedirMail: pedirMail };
})();
