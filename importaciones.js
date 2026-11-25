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
      'despachante:despachantes(nombre),unif:operacion_ops_unificadas(op_numero,nota),' +
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
        rest('eventos', { metodo: 'POST', cuerpo: { operacion_id: id, evento: 'estado cambiado', usuario: ses && ses.uid } }).catch(function () {});
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

  return { login: login, iniciar: iniciar, salir: salir, abrir: abrir, filtrar: filtrar, buscar: buscar,
           ficha: ficha, estado: estado, guardarOp: guardarOp };
})();
