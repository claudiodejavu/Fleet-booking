"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const dateInput = (d, h, m = 0) => `${dateKey(d)}T${pad(h)}:${pad(m)}`;
const defaultBookingTimes = (d) => {
  const now = new Date();
  let startMinutes = 9 * 60;
  if (dateKey(d) === dateKey(now)) startMinutes = Math.min(23 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes() + 5) / 15) * 15);
  const endMinutes = Math.min(23 * 60 + 59, Math.max(startMinutes + 60, 17 * 60));
  return [dateInput(d, Math.floor(startMinutes / 60), startMinutes % 60), dateInput(d, Math.floor(endMinutes / 60), endMinutes % 60)];
};
const parseDate = (s) => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
const fmtTime = (s) => new Date(s).toLocaleTimeString("es-ES", {hour:"2-digit",minute:"2-digit"});
const fmtDateTime = (s) => new Date(s).toLocaleString("es-ES", {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = (d) => new Date(d.getFullYear(), d.getMonth()+1, 1);
const overlaps = (a,b,c,d) => new Date(a) < new Date(d) && new Date(b) > new Date(c);

export default function Home() {
  const [session,setSession] = useState(null);
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const [profile,setProfile] = useState(null);
  const [isAdmin,setIsAdmin] = useState(false);
  const [vehicles,setVehicles] = useState([]);
  const [reservations,setReservations] = useState([]);
  const [profiles,setProfiles] = useState([]);
  const [month,setMonth] = useState(() => new Date(new Date().getFullYear(),new Date().getMonth(),1));
  const [selectedDay,setSelectedDay] = useState(dateKey(new Date()));
  const [start,setStart] = useState(() => defaultBookingTimes(new Date())[0]);
  const [end,setEnd] = useState(() => defaultBookingTimes(new Date())[1]);
  const [selectedVehicles,setSelectedVehicles] = useState([]);
  const [work,setWork] = useState("");
  const [inviteEmail,setInviteEmail] = useState("");
  const [inviteProfile,setInviteProfile] = useState("");
  const [newFleetName,setNewFleetName] = useState("");
  const [invitePassword,setInvitePassword] = useState("");
  const [inviteFlow,setInviteFlow] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const [messageType,setMessageType] = useState("info");

  const notify = (text,type="info") => { setMessage(text); setMessageType(type); };
  const loadData = useCallback(async (currentSession) => {
    if (!supabase || !currentSession) return;
    const uid = currentSession.user.id;
    const [p, a, v, r, unlinked] = await Promise.all([
      supabase.from("fleet_users").select("id,name").eq("auth_user_id",uid).maybeSingle(),
      supabase.from("fleet_admins").select("user_id").eq("user_id",uid).maybeSingle(),
      supabase.from("vehicles").select("id,plate,make_model,provider,active").eq("active",true).order("plate"),
      supabase.from("reservations").select("id,vehicle_id,fleet_user_id,created_by,start_at,end_at,work_description").gte("end_at",monthStart(month).toISOString()).lt("start_at",monthEnd(month).toISOString()).order("start_at"),
      supabase.from("fleet_users").select("id,name,auth_user_id").is("auth_user_id",null).order("name")
    ]);
    if (p.error) notify(p.error.message,"error");
    if (v.error) notify(v.error.message,"error");
    if (r.error) notify(r.error.message,"error");
    setProfile(p.data || null);
    setIsAdmin(!!a.data);
    setVehicles(v.data || []);
    setReservations(r.data || []);
    setProfiles(unlinked.data || []);
  },[month]);

  useEffect(() => {
    if (!supabase) return;
    if (window.location.hash.includes("type=invite")) setInviteFlow(true);
    supabase.auth.getSession().then(({data}) => setSession(data.session));
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_event,s) => setSession(s));
    return () => subscription.unsubscribe();
  },[]);

  useEffect(() => {
    if (!session || !supabase) return;
    loadData(session);
    const channel = supabase.channel("fleet-reservations-live")
      .on("postgres_changes",{event:"*",schema:"public",table:"reservations"},() => loadData(session))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  },[session,loadData]);

  const days = useMemo(() => {
    const first = monthStart(month);
    const offset = (first.getDay()+6)%7;
    return Array.from({length:42},(_,i) => new Date(first.getFullYear(),first.getMonth(),i-offset+1));
  },[month]);

  const selectedDayReservations = useMemo(() => reservations.filter(r => dateKey(new Date(r.start_at)) === selectedDay || (new Date(r.start_at) < parseDate(selectedDay) && new Date(r.end_at) > parseDate(selectedDay))),[reservations,selectedDay]);
  const availability = useMemo(() => vehicles.map(v => ({
    ...v,
    conflicts: selectedDayReservations.filter(r => r.vehicle_id===v.id && overlaps(r.start_at,r.end_at,start,end)),
  })),[vehicles,selectedDayReservations,start,end]);

  async function login(e) {
    e.preventDefault(); setBusy(true); notify("");
    const {error} = await supabase.auth.signInWithPassword({email,password});
    setBusy(false); if(error) notify(error.message,"error");
  }

  async function book(e) {
    e.preventDefault();
    if (!profile) return notify("Tu cuenta todavía no está vinculada a un perfil de flota. Contacta con el administrador.","error");
    if (!work.trim()) return notify("Indica el Proyecto / Varios antes de reservar.","error");
    if (new Date(end) <= new Date(start)) return notify("La hora de fin debe ser posterior al inicio.","error");
    if (dateKey(new Date(start)) !== selectedDay) return notify("La fecha de inicio debe coincidir con el día seleccionado en el calendario.","error");
    if (new Date(start).getTime() < Date.now()-60000) return notify("No se pueden crear reservas con fecha de inicio pasada.","error");
    if (new Date(start).getTime() > Date.now()+30*24*60*60*1000) return notify("Las reservas se pueden realizar con un máximo de 30 días de antelación.","error");
    if (!selectedVehicles.length) return notify("Selecciona al menos un vehículo disponible.","error");
    const blocked = availability.filter(v => selectedVehicles.includes(v.id) && v.conflicts.length);
    if (blocked.length) return notify("Uno o más vehículos ya están ocupados en ese horario. Actualiza la disponibilidad.","error");
    setBusy(true); notify("");
    const {data:createdCount,error} = await supabase.rpc("create_fleet_reservations",{
      p_vehicle_ids:selectedVehicles,
      p_start_at:new Date(start).toISOString(),
      p_end_at:new Date(end).toISOString(),
      p_work_description:work.trim()
    });
    setBusy(false);
    if(error) {
      if(error.code==="23P01") notify("Otro usuario acaba de reservar uno de esos vehículos en ese horario. No se ha guardado ninguna reserva de esta solicitud; actualiza la disponibilidad y vuelve a elegir.","error");
      else notify(error.message || "No se pudo completar la reserva. Inténtalo de nuevo.","error");
    } else {
      notify(`Reserva creada correctamente para ${createdCount || selectedVehicles.length} vehículo(s).`,"success");
      setSelectedVehicles([]); setWork(""); await loadData(session);
    }
  }

  async function deleteReservation(id) {
    if (!window.confirm("¿Seguro que quieres eliminar esta reserva? Esta acción no se puede deshacer.")) return;
    setBusy(true); const {error} = await supabase.from("reservations").delete().eq("id",id);
    setBusy(false);
    if(error) notify(error.message,"error"); else { notify("Reserva eliminada.","success"); await loadData(session); }
  }

  async function invite(e) {
    e.preventDefault();
    if (!inviteProfile) return notify("Selecciona el perfil de flota que vas a vincular.","error");
    setBusy(true); notify("");
    const {data,error} = await supabase.functions.invoke("fleet-invite-user",{body:{email:inviteEmail.trim(),fleet_user_id:inviteProfile,fleet_name:newFleetName.trim()}});
    setBusy(false);
    if(error || data?.error) notify(data?.error || error.message,"error");
    else { notify(`Invitación enviada a ${inviteEmail}. El perfil ya está vinculado.`,"success"); setInviteEmail(""); setInviteProfile(""); setNewFleetName(""); await loadData(session); }
  }

  async function activateAccount(e) {
    e.preventDefault();
    if (invitePassword.length < 8) return notify("La contraseña debe tener al menos 8 caracteres.","error");
    setBusy(true);
    const {error} = await supabase.auth.updateUser({password:invitePassword});
    setBusy(false);
    if (error) notify(error.message,"error");
    else { setInviteFlow(false); setInvitePassword(""); window.history.replaceState({},document.title,window.location.pathname); notify("Contraseña establecida. Ya puedes utilizar Fleet Booking.","success"); }
  }

  function toggleVehicle(id) {
    setSelectedVehicles(current => current.includes(id) ? current.filter(x=>x!==id) : [...current,id]);
  }

  if (!supabase) return <main className="shell"><section className="panel"><h1>Fleet Booking</h1><p>Falta configurar la conexión con Supabase en Vercel.</p></section></main>;

  if (!session) return <main className="login-shell">
    <section className="login-story">
      <img className="brand-logo" src="https://dejavuproject.es/wp-content/uploads/logo-dejavu-project.svg" alt="Dejavu Project"/>
      <p className="login-eyebrow">DEJAVU PROJECT <span>／</span> MOVILIDAD INTERNA</p>
      <div className="login-statement"><span>Nos movemos</span><strong>para crear</strong><em>experiencias.</em></div>
      <p className="login-story-copy">Cada proyecto empieza con una buena planificación. Gestiona los desplazamientos del equipo desde un único lugar.</p>
      <div className="login-index"><span>01 — 03</span><span>FLEET BOOKING</span><span>MAD · VLC · BCN</span></div>
      <div className="login-orbit orbit-one"></div><div className="login-orbit orbit-two"></div>
    </section>
    <section className="login-card">
      <p className="kicker">ÁREA PRIVADA <span>／</span> ACCESO DE EQUIPO</p>
      <h1>Bienvenido<span>.</span></h1>
      <p className="muted">Accede para organizar tus desplazamientos de trabajo.</p>
      <form onSubmit={login} className="stack">
        <label>Correo electrónico<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" placeholder="nombre@dejavuproject.es"/></label>
        <label>Contraseña<input type="password" required value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" placeholder="Tu contraseña"/></label>
        <button disabled={busy}>{busy?"Entrando…":"Entrar en la aplicación"} <span aria-hidden="true">↗</span></button>
      </form>
      {message && <p className={`notice ${messageType}`}>{message}</p>}
      <p className="login-security">ACCESO RESTRINGIDO · SOLO PERSONAL AUTORIZADO</p>
    </section>
  </main>;

  return <main className="shell">
    <header className="topbar">
      <div className="brand-lockup"><img className="brand-logo" src="https://dejavuproject.es/wp-content/uploads/logo-dejavu-project.svg" alt="Dejavu Project"/><span className="brand-divider"></span><div><p className="kicker">OPERACIONES</p><h1>Fleet Booking</h1></div></div>
      <div className="top-actions">{profile && <span className="user-chip">{profile.name}</span>}{isAdmin && <span className="admin-chip">Administrador</span>}<button className="button-light" onClick={()=>supabase.auth.signOut()}>Cerrar sesión</button></div>
    </header>

    {inviteFlow && <section className="panel activation-panel"><p className="kicker">ACTIVACIÓN DE CUENTA</p><h2>Establece tu contraseña</h2><p className="muted">Ya has validado tu invitación. Crea una contraseña de al menos 8 caracteres para acceder a Fleet Booking.</p><form onSubmit={activateAccount} className="invite-form"><label>Nueva contraseña<input type="password" minLength={8} required value={invitePassword} onChange={e=>setInvitePassword(e.target.value)} autoComplete="new-password"/></label><button disabled={busy}>{busy?"Guardando…":"Activar cuenta"}</button></form></section>}
    <section className="hero">
      <div><p className="kicker">GESTIÓN DE MOVILIDAD</p><h2>Organiza los desplazamientos de trabajo</h2><p>Consulta el calendario y reserva los vehículos que necesitas.</p></div>
      <div className="hero-stat"><strong>{vehicles.length.toString().padStart(2,"0")}</strong><span>Vehículos activos</span></div>
    </section>

    {!profile && <div className="notice error">Tu cuenta está autenticada, pero no está vinculada a un perfil de flota. Contacta con el administrador para completar el alta.</div>}

    <section className="calendar-panel panel">
      <div className="section-heading"><div><p className="kicker">PLANIFICACIÓN</p><h2>Calendario de reservas</h2></div><div className="month-controls"><button className="icon-button" aria-label="Mes anterior" onClick={()=>{const d=new Date(month.getFullYear(),month.getMonth()-1,1);setMonth(d);setSelectedDay(dateKey(d));setStart(defaultBookingTimes(d)[0]);setEnd(defaultBookingTimes(d)[1]);setSelectedVehicles([]);}}>‹</button><strong>{month.toLocaleDateString("es-ES",{month:"long",year:"numeric"})}</strong><button className="icon-button" aria-label="Mes siguiente" onClick={()=>{const d=new Date(month.getFullYear(),month.getMonth()+1,1);setMonth(d);setSelectedDay(dateKey(d));setStart(defaultBookingTimes(d)[0]);setEnd(defaultBookingTimes(d)[1]);setSelectedVehicles([]);}}>›</button></div></div>
      <p className="calendar-note">Puedes consultar cualquier mes. Las reservas se pueden crear desde ahora y hasta 30 días por adelantado.</p>
      <div className="calendar-grid weekday-row">{["L","M","X","J","V","S","D"].map((d,i)=><div key={i}>{d}</div>)}</div>
      <div className="calendar-grid">{days.map((d,i)=>{
        const key=dateKey(d), inMonth=d.getMonth()===month.getMonth();
        const count=reservations.filter(r=>dateKey(new Date(r.start_at))===key || (new Date(r.start_at)<new Date(d.getFullYear(),d.getMonth(),d.getDate()) && new Date(r.end_at)>new Date(d.getFullYear(),d.getMonth(),d.getDate()))).length;
        return <button key={key} className={`day-cell ${inMonth?"":"outside"} ${key===selectedDay?"selected":""} ${key===dateKey(new Date())?"today":""}`} onClick={()=>{setSelectedDay(key);if(!inMonth)setMonth(monthStart(d));setStart(defaultBookingTimes(d)[0]);setEnd(defaultBookingTimes(d)[1]);setSelectedVehicles([]);}}>
          <span>{d.getDate()}</span>{count>0&&<small>{count} {count===1?"reserva":"reservas"}</small>}
        </button>;
      })}</div>
      <div className="legend"><span><i className="dot today-dot"/> Hoy</span><span><i className="dot selected-dot"/> Día seleccionado</span><span>Los cambios se actualizan en tiempo real</span></div>
    </section>

    <section className="booking-layout">
      <div className="panel booking-panel">
        <div className="section-heading"><div><p className="kicker">NUEVA SOLICITUD</p><h2>{parseDate(selectedDay).toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long"})}</h2></div><span className="count-pill">{availability.filter(v=>!v.conflicts.length).length} libres</span></div>
        <form onSubmit={book} className="stack">
          <div className="time-row"><label>Desde<input type="datetime-local" required min={dateInput(new Date(),new Date().getHours(),new Date().getMinutes())} max={dateInput(new Date(Date.now()+30*24*60*60*1000),23,59)} value={start} onChange={e=>setStart(e.target.value)}/></label><label>Hasta<input type="datetime-local" required min={start} value={end} onChange={e=>setEnd(e.target.value)}/></label></div>
          <div className="vehicle-picker"><div className="picker-title"><strong>Vehículos para este horario</strong><span>Selecciona uno o varios</span></div>
            {availability.map(v=><label key={v.id} className={`vehicle-option ${v.conflicts.length?"occupied":""} ${selectedVehicles.includes(v.id)?"chosen":""}`}>
              <input type="checkbox" disabled={!!v.conflicts.length || !profile} checked={selectedVehicles.includes(v.id)} onChange={()=>toggleVehicle(v.id)}/>
              <span className="vehicle-symbol">▰</span><span className="vehicle-details"><strong>{v.plate}</strong><small>{v.make_model} · {v.provider}</small></span>
              <span className={`availability-tag ${v.conflicts.length?"busy":"free"}`}>{v.conflicts.length?"Ocupado":"Disponible"}</span>
            </label>)}
            {!availability.length&&<p className="muted">No hay vehículos activos.</p>}
          </div>
          <label>Proyecto / Varios<input value={work} onChange={e=>setWork(e.target.value)} placeholder="Indica el proyecto o escribe Varios" required maxLength={160}/></label>
          <button disabled={busy||!profile||!selectedVehicles.length||!work.trim()}>{busy?"Procesando…":`Reservar ${selectedVehicles.length||""} vehículo(s)`}</button>
        </form>
      </div>
      <div className="panel day-panel">
        <p className="kicker">ACTIVIDAD DEL DÍA</p><h2>Reservas existentes</h2>
        {selectedDayReservations.length ? <div className="reservation-list">{selectedDayReservations.map(r=>{
          const v=vehicles.find(x=>x.id===r.vehicle_id);
          return <article className="reservation-item" key={r.id}><div className="reservation-time">{fmtTime(r.start_at)}<span>—</span>{fmtTime(r.end_at)}</div><div className="reservation-info"><strong>{v?.plate||"Vehículo"}</strong><small>{r.work_description||"Desplazamiento de trabajo"}</small></div>{(isAdmin||r.created_by===session.user.id)&&<button className="delete-button" disabled={busy} onClick={()=>deleteReservation(r.id)}>Eliminar</button>}</article>;
        })}</div>:<div className="empty-state"><span>✓</span><strong>Sin reservas para este día</strong><p>Los vehículos están libres, según los horarios seleccionados.</p></div>}
      </div>
    </section>

    {isAdmin && <section className="panel admin-panel">
      <div className="section-heading"><div><p className="kicker">GESTIÓN DE ACCESOS</p><h2>Invitar a un usuario</h2><p className="muted">Envía una invitación y vincula la cuenta con un perfil de flota existente.</p></div><span className="admin-chip">Solo administrador</span></div>
      <form onSubmit={invite} className="invite-form">
        <label>Perfil de flota<select required value={inviteProfile} onChange={e=>setInviteProfile(e.target.value)}><option value="">Selecciona una persona</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}<option value="__new__">＋ Crear un perfil nuevo</option></select></label>
        {inviteProfile==="__new__" && <label>Nombre de la persona<input required minLength={2} maxLength={80} value={newFleetName} onChange={e=>setNewFleetName(e.target.value)} placeholder="Nombre y apellidos"/></label>}
        <label>Correo electrónico<input type="email" required value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="nombre@empresa.com"/></label>
        <button disabled={busy||(!profiles.length&&inviteProfile!=="__new__")||!inviteProfile}>{busy?"Enviando…":"Enviar invitación"}</button>
      </form>
      {!profiles.length&&inviteProfile!=="__new__"&&<p className="notice success">Todos los perfiles existentes están vinculados. Puedes crear un perfil nuevo desde el selector.</p>}
      <p className="admin-help">La persona recibirá un correo de Supabase para activar su acceso y establecer su contraseña. No compartas contraseñas por correo.</p>
    </section>}

    {message && <div className={`notice ${messageType}`} role="status">{message}</div>}
    <footer><span>DEJAVU PROJECT</span><span>Fleet Booking · Acceso privado</span></footer>
  </main>;
}
