import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert,
  Vibration, Animated, ActivityIndicator, StatusBar, Platform,
  KeyboardAvoidingView, Dimensions, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { CameraView, useCameraPermissions } from 'expo-camera';

// Configuration comes from the .env file through app.config.js
const extra = (Constants.expoConfig && Constants.expoConfig.extra) || {};
const SERVER = extra.server || '';
const TOKEN = extra.token || '';
const GITHUB_REPO = extra.githubRepo || '';
const DEBUG = !!extra.debug;
const VERSION = (Constants.expoConfig && Constants.expoConfig.version) || '1.0.0';

const COLORS = {
  primary: '#14324F', primaryDark: '#0C2238', accent: '#B7791F',
  bg: '#F3F5F8', card: '#FFFFFF', border: '#DDE3EA',
  text: '#16222E', muted: '#64748B', ok: '#15803D', err: '#B91C1C',
};
const FRAME_OK = '#22C55E';
const FRAME_BAD = '#EF4444';
const STEPS = [
  { key: 'front', label: 'Front' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
  { key: 'up', label: 'Up' },
  { key: 'bottom', label: 'Down' },
];
const TARGET_PHOTO_SIDE = 1600; // long side of the camera photo in pixels (Android)
const TOP = Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight || 24) + 8;
const { width: W, height: H } = Dimensions.get('window');
const TOP_BAR_H = TOP + 56;
const PANEL_H = 170;
const EMPTY_FORM = {
  employee_id: '', employee_card_no: '', employee_name: '',
  deptt_name: '', section_name: '', designation_name: '',
};

// ---------- version helpers ----------
const parseVer = (v) => String(v || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
const isNewer = (a, b) => {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) > (y[i] || 0)) return true;
    if ((x[i] || 0) < (y[i] || 0)) return false;
  }
  return false;
};

// ---------- small components ----------
const Btn = ({ title, onPress, kind = 'primary', disabled }) => (
  <TouchableOpacity
    activeOpacity={0.85}
    disabled={disabled}
    onPress={onPress}
    style={[
      st.btn,
      kind === 'outline' && st.btnOutline,
      kind === 'danger' && st.btnDanger,
      disabled && { opacity: 0.5 },
    ]}
  >
    <Text style={[st.btnTx, kind === 'outline' && { color: COLORS.primary }]}>{title}</Text>
  </TouchableOpacity>
);

const Field = ({ label, error, ...p }) => (
  <View style={{ marginBottom: 14 }}>
    <Text style={st.label}>{label}</Text>
    <TextInput
      style={[st.input, error && { borderColor: COLORS.err }]}
      placeholderTextColor="#94A3B8"
      {...p}
    />
  </View>
);

const Header = ({ title, onBack }) => (
  <View style={st.header}>
    {onBack ? (
      <TouchableOpacity onPress={onBack} style={st.backBtn}>
        <Text style={st.backTx}>‹</Text>
      </TouchableOpacity>
    ) : null}
    <Text style={st.headerTx}>{title}</Text>
  </View>
);

const MenuRow = ({ title, sub, onPress }) => (
  <TouchableOpacity style={st.menuRow} activeOpacity={0.85} onPress={onPress}>
    <View style={st.menuBar} />
    <View style={{ flex: 1 }}>
      <Text style={st.menuTitle}>{title}</Text>
      <Text style={st.menuSub}>{sub}</Text>
    </View>
    <Text style={st.menuArrow}>›</Text>
  </TouchableOpacity>
);

// ---------- app ----------
export default function App() {
  const [perm, askPerm] = useCameraPermissions();
  const [screen, setScreen] = useState('home'); // home | form | camera | result | history
  const [history, setHistory] = useState([]);
  const [online, setOnline] = useState(null); // null = checking
  const [update, setUpdate] = useState(null); // { version, url } when a newer release exists
  const [f, setF] = useState(EMPTY_FORM);
  const [tried, setTried] = useState(false);
  const [facing, setFacing] = useState('front');
  const [pictureSize, setPictureSize] = useState(undefined);
  const [got, setGot] = useState(0);
  const [msg, setMsg] = useState('');
  const [dbg, setDbg] = useState('');
  const [match, setMatch] = useState(null); // null = waiting, true = good position, false = wrong
  const [result, setResult] = useState({ ok: true, text: '' });

  const cam = useRef(null);
  const ws = useRef(null);
  const on = useRef(false);
  const ready = useRef(false);
  const submitting = useRef(false);
  const facingRef = useRef('front');
  const gotRef = useRef(0);
  const lastMsg = useRef(0);
  const timer = useRef(null);
  const pulse = useRef(new Animated.Value(1)).current;

  // ---------- startup ----------
  useEffect(() => {
    (async () => {
      try {
        const h = await AsyncStorage.getItem('history');
        if (h) setHistory(JSON.parse(h));
      } catch (e) {}
    })();
    checkUpdate();
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.01, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    ).start();
    return () => { clearInterval(timer.current); try { ws.current && ws.current.close(); } catch (e) {} };
  }, []);

  // ---------- update check (latest GitHub release) ----------
  const checkUpdate = async () => {
    if (!GITHUB_REPO) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return;
      const d = await r.json();
      if (isNewer(d.tag_name, VERSION)) {
        const apk = (d.assets || []).find((a) => /\.apk$/i.test(a.name));
        setUpdate({
          version: String(d.tag_name).replace(/^v/i, ''),
          url: apk ? apk.browser_download_url : d.html_url,
        });
      }
    } catch (e) {
      clearTimeout(t);
    }
  };

  // ---------- server check ----------
  const pingServer = async () => {
    if (!SERVER) return false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(`http://${SERVER}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch (e) {
      clearTimeout(t);
      return false;
    }
  };

  const recheck = () => { setOnline(null); pingServer().then(setOnline); };

  useEffect(() => { if (screen === 'home') recheck(); }, [screen]);

  // ---------- history ----------
  const addHistory = async (item) => {
    try {
      const raw = await AsyncStorage.getItem('history');
      const list = raw ? JSON.parse(raw) : [];
      const n = [item, ...list].slice(0, 50);
      await AsyncStorage.setItem('history', JSON.stringify(n));
      setHistory(n);
    } catch (e) {}
  };

  const clearHistory = () => {
    Alert.alert('History', 'Delete all history records?', [
      { text: 'Cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await AsyncStorage.removeItem('history'); setHistory([]); } },
    ]);
  };

  // ---------- camera photo size (keeps uploads small, mainly for the back camera) ----------
  const pickPictureSize = async () => {
    if (Platform.OS !== 'android' || !cam.current) return;
    try {
      const sizes = await cam.current.getAvailablePictureSizesAsync();
      let best = null;
      let bestScore = Infinity;
      (sizes || []).forEach((s) => {
        const m = /^(\d+)x(\d+)$/.exec(s);
        if (!m) return;
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        const long = Math.max(a, b);
        const short = Math.min(a, b);
        if (long < 1000) return; // too small for a good face photo
        const notFourThree = Math.abs(long / short - 4 / 3) > 0.05 ? 2000 : 0;
        const score = Math.abs(long - TARGET_PHOTO_SIDE) + notFourThree;
        if (score < bestScore) { bestScore = score; best = s; }
      });
      if (best) setPictureSize(best);
    } catch (e) {}
  };

  // ---------- enrollment ----------
  const grab = async () => {
    if (!on.current || !cam.current || !ws.current || ws.current.readyState !== 1) return;
    if (!ready.current) { setTimeout(grab, 300); return; }
    try {
      const p = await cam.current.takePictureAsync({
        quality: 0.5,
        base64: true,
        skipProcessing: true,
        shutterSound: false,
      });
      ws.current.send(JSON.stringify({ type: 'frame', data: p.base64, facing: facingRef.current }));
    } catch (e) {
      setTimeout(grab, 500);
    }
  };

  const flip = () => {
    if (gotRef.current > 0) return; // camera can only be changed before the first capture
    const next = facingRef.current === 'front' ? 'back' : 'front';
    facingRef.current = next;
    ready.current = false;
    setPictureSize(undefined);
    setFacing(next);
    setTimeout(() => { ready.current = true; }, 1200);
  };

  const cleanup = () => {
    on.current = false;
    submitting.current = false;
    clearInterval(timer.current);
    try { ws.current && ws.current.close(); } catch (e) {}
  };

  const endSession = (ok, text) => {
    if (!on.current) return;
    cleanup();
    addHistory({ id: f.employee_id, name: f.employee_name, ok, time: new Date().toLocaleString() });
    setResult({ ok, text });
    setScreen('result');
  };

  const cancel = () => { cleanup(); setScreen('home'); };

  const start = async () => {
    setTried(true);
    if (!SERVER || !TOKEN) {
      Alert.alert('Not configured', 'Server address or token is missing. Check the .env file and restart the app.');
      return;
    }
    if (!f.employee_id.trim() || !f.employee_card_no.trim() || !f.employee_name.trim()) {
      Alert.alert('Incomplete form', 'Employee ID, Card No and Name are required.');
      return;
    }
    if (!perm || !perm.granted) {
      const r = await askPerm();
      if (!r.granted) { Alert.alert('Camera', 'Camera permission is required.'); return; }
    }
    gotRef.current = 0;
    ready.current = false;
    submitting.current = false;
    on.current = true;
    lastMsg.current = Date.now();
    setGot(0); setDbg(''); setMatch(null);
    setMsg('Connecting to server...');
    setScreen('camera');

    const s = new WebSocket(`ws://${SERVER}/ws/enroll?token=${encodeURIComponent(TOKEN)}`);
    ws.current = s;

    s.onmessage = (e) => {
      const d = JSON.parse(e.data);
      lastMsg.current = Date.now();
      if (d.type === 'status') {
        const captured = d.got > gotRef.current;
        if (captured) Vibration.vibrate(120);
        gotRef.current = d.got;
        setGot(d.got);
        setMsg(d.msg);
        setDbg(d.dbg || '');
        setMatch(!!d.match);
        if (d.done) {
          submitting.current = true;
          setMsg('Uploading data...');
          s.send(JSON.stringify({ type: 'submit', ...f }));
        } else {
          // short pause after a capture, then keep going as fast as possible
          setTimeout(grab, captured ? 500 : d.match ? 0 : 100);
        }
      } else if (d.type === 'result') {
        endSession(d.ok, d.detail);
      }
    };
    s.onerror = () => {};
    s.onclose = () => endSession(false, 'Could not connect to the server, or the connection was lost.\nPlease check the WiFi connection and try again.');

    // if the server stays silent for 8 seconds, send a new frame
    timer.current = setInterval(() => {
      if (on.current && ready.current && !submitting.current && Date.now() - lastMsg.current > 8000) grab();
    }, 4000);
  };

  const newEnrollment = () => { setF(EMPTY_FORM); setTried(false); setScreen('form'); };

  // ================= SCREENS =================

  if (screen === 'camera') {
    const frameColor = match === null ? '#FFFFFF' : match ? FRAME_OK : FRAME_BAD;
    return (
      <View style={{ width: W, height: H, backgroundColor: '#000' }}>
        <StatusBar barStyle="light-content" />
        <CameraView
          ref={cam}
          style={StyleSheet.absoluteFill}
          facing={facing}
          pictureSize={pictureSize}
          animateShutter={false}
          onCameraReady={() => { ready.current = true; pickPictureSize(); }}
        />

        <View style={st.camTop}>
          <View style={{ flex: 1 }}>
            <Text style={st.camTitle}>Face Enrollment</Text>
            <Text style={st.camSub} numberOfLines={1}>{f.employee_name}  |  ID {f.employee_id}</Text>
          </View>
          <TouchableOpacity
            style={[st.topBtn, got > 0 && { opacity: 0.35 }]}
            onPress={flip}
            disabled={got > 0}
            activeOpacity={0.8}
          >
            <Text style={st.topBtnTx}>Flip</Text>
          </TouchableOpacity>
          <TouchableOpacity style={st.topBtn} onPress={cancel} activeOpacity={0.8}>
            <Text style={st.topBtnTx}>Cancel</Text>
          </TouchableOpacity>
        </View>

        <Animated.View
          pointerEvents="none"
          style={[
            st.frame,
            {
              borderColor: frameColor,
              backgroundColor: match ? 'rgba(34,197,94,0.10)' : 'transparent',
              transform: [{ scale: pulse }],
            },
          ]}
        />

        <View style={st.camBottom}>
          <View>
            <Text style={st.camMsg} numberOfLines={2}>{msg}</Text>
            {DEBUG && dbg ? <Text style={st.camDbg}>{dbg}</Text> : null}
          </View>
          <View style={st.stepsRow}>
            {STEPS.map((s, i) => {
              const done = i < got;
              const now = i === got;
              return (
                <View key={s.key} style={st.stepItem}>
                  <View style={[st.stepDot, done && st.stepDotDone, now && st.stepDotNow]}>
                    <Text style={st.stepNum}>{done ? '✓' : i + 1}</Text>
                  </View>
                  <Text style={[st.stepLabel, (done || now) && { color: '#fff' }]}>{s.label}</Text>
                </View>
              );
            })}
          </View>
        </View>
      </View>
    );
  }

  if (screen === 'result') {
    return (
      <View style={st.center}>
        <StatusBar barStyle="dark-content" />
        <View style={[st.resCircle, { backgroundColor: result.ok ? COLORS.ok : COLORS.err }]}>
          <Text style={st.resSymbol}>{result.ok ? '✓' : '✕'}</Text>
        </View>
        <Text style={[st.resTitle, { color: result.ok ? COLORS.ok : COLORS.err }]}>
          {result.ok ? 'Enrollment Successful' : 'Enrollment Failed'}
        </Text>
        <Text style={st.resName}>{f.employee_name}  |  ID {f.employee_id}</Text>
        <View style={st.detailBox}>
          <Text style={st.detailLabel}>SERVER RESPONSE</Text>
          <ScrollView style={{ maxHeight: 110 }}>
            <Text style={st.detail}>{String(result.text).slice(0, 600)}</Text>
          </ScrollView>
        </View>
        {!result.ok ? <Btn title="Try Again" onPress={start} /> : null}
        <View style={{ height: 10 }} />
        <Btn
          title={result.ok ? 'New Enrollment' : 'Edit Details'}
          kind={result.ok ? 'primary' : 'outline'}
          onPress={result.ok ? newEnrollment : () => setScreen('form')}
        />
        <View style={{ height: 10 }} />
        <Btn title="Back to Home" kind="outline" onPress={() => setScreen('home')} />
      </View>
    );
  }

  if (screen === 'form') {
    return (
      <View style={st.page}>
        <StatusBar barStyle="light-content" />
        <Header title="Employee Details" onBack={() => setScreen('home')} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: 18 }} keyboardShouldPersistTaps="handled">
            <View style={st.card}>
              <Text style={st.cardTitle}>REQUIRED INFORMATION</Text>
              <Field label="Employee ID" placeholder="000000" keyboardType="number-pad"
                error={tried && !f.employee_id.trim()}
                value={f.employee_id} onChangeText={(t) => setF({ ...f, employee_id: t })} />
              <Field label="Card No" placeholder="000000" keyboardType="number-pad"
                error={tried && !f.employee_card_no.trim()}
                value={f.employee_card_no} onChangeText={(t) => setF({ ...f, employee_card_no: t })} />
              <Field label="Full Name" placeholder="Zain Akram"
                error={tried && !f.employee_name.trim()}
                value={f.employee_name} onChangeText={(t) => setF({ ...f, employee_name: t })} />
            </View>

            <View style={st.card}>
              <Text style={st.cardTitle}>ORGANIZATION DETAILS (OPTIONAL)</Text>
              <Field label="Department" placeholder="Information Technology"
                value={f.deptt_name} onChangeText={(t) => setF({ ...f, deptt_name: t })} />
              <Field label="Section" placeholder="Development and Support"
                value={f.section_name} onChangeText={(t) => setF({ ...f, section_name: t })} />
              <Field label="Designation" placeholder="MTO"
                value={f.designation_name} onChangeText={(t) => setF({ ...f, designation_name: t })} />
            </View>

            <View style={st.tips}>
              <Text style={st.tipsTitle}>Guidelines</Text>
              <Text style={st.tipsTx}>• Use good lighting and avoid strong light from behind</Text>
              <Text style={st.tipsTx}>• Remove cap, mask and glasses</Text>
              <Text style={st.tipsTx}>• Keep the phone steady, at face level</Text>
              <Text style={st.tipsTx}>• Turn the head slowly and pause until the frame turns green</Text>
            </View>
            <Btn title="Start Face Capture" onPress={start} />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  if (screen === 'history') {
    return (
      <View style={st.page}>
        <StatusBar barStyle="light-content" />
        <Header title="Enrollment History" onBack={() => setScreen('home')} />
        <ScrollView contentContainerStyle={{ padding: 18 }}>
          {history.length === 0 ? <Text style={st.empty}>No enrollments recorded yet.</Text> : null}
          {history.map((h, i) => (
            <View key={i} style={st.row}>
              <View style={{ flex: 1 }}>
                <Text style={st.rowName}>{h.name}</Text>
                <Text style={st.rowSub}>ID {h.id}  |  {h.time}</Text>
              </View>
              <Text style={[st.rowStatus, { color: h.ok ? COLORS.ok : COLORS.err }]}>
                {h.ok ? 'SUCCESS' : 'FAILED'}
              </Text>
            </View>
          ))}
          {history.length > 0 ? <Btn title="Clear History" kind="danger" onPress={clearHistory} /> : null}
        </ScrollView>
      </View>
    );
  }

  // ---------- HOME ----------
  return (
    <View style={st.page}>
      <StatusBar barStyle="light-content" />
      <View style={st.hero}>
        <Text style={st.company}>SM FOODS</Text>
        <Text style={st.product}>Employee Face Enrollment</Text>
        <TouchableOpacity style={st.badge} onPress={recheck} activeOpacity={0.8}>
          {online === null ? <ActivityIndicator size="small" color="#fff" /> :
            <View style={[st.dot, { backgroundColor: online ? '#4ADE80' : '#F87171' }]} />}
          <Text style={st.badgeTx}>
            {!SERVER ? 'App is not configured (.env)'
              : online === null ? 'Checking server...'
              : online ? 'Server connected' : 'Server unreachable (tap to retry)'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={{ padding: 20 }}>
        {update ? (
          <View style={st.updateCard}>
            <View style={{ flex: 1 }}>
              <Text style={st.updateTitle}>Update available: version {update.version}</Text>
              <Text style={st.updateSub}>You are using version {VERSION}</Text>
            </View>
            <TouchableOpacity style={st.updateBtn} activeOpacity={0.85} onPress={() => Linking.openURL(update.url)}>
              <Text style={st.updateBtnTx}>Download</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={st.sectionTitle}>MENU</Text>
        <MenuRow title="New Enrollment" sub="Register an employee's face" onPress={newEnrollment} />
        <MenuRow title="Enrollment History" sub={`${history.length} records on this device`} onPress={() => setScreen('history')} />
      </View>
      <Text style={st.footer}>SM FaceID  |  Version {VERSION}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center', padding: 24 },

  header: { backgroundColor: COLORS.primary, paddingTop: TOP, paddingBottom: 16, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center' },
  headerTx: { color: '#fff', fontSize: 19, fontWeight: '600', letterSpacing: 0.3 },
  backBtn: { paddingRight: 14, paddingVertical: 2 },
  backTx: { color: '#fff', fontSize: 30, lineHeight: 30 },

  hero: { backgroundColor: COLORS.primary, paddingTop: TOP + 24, paddingBottom: 30, paddingHorizontal: 22 },
  company: { color: '#fff', fontSize: 30, fontWeight: '800', letterSpacing: 4 },
  product: { color: '#B8C7D9', fontSize: 14, marginTop: 4, letterSpacing: 0.5 },
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.12)', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, marginTop: 20 },
  badgeTx: { color: '#fff', marginLeft: 8, fontSize: 12 },
  dot: { width: 9, height: 9, borderRadius: 5 },

  updateCard: { backgroundColor: '#FEF3C7', borderLeftWidth: 3, borderLeftColor: COLORS.accent, borderRadius: 6, padding: 14, flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  updateTitle: { color: '#92400E', fontWeight: '700', fontSize: 13 },
  updateSub: { color: '#92400E', fontSize: 11, marginTop: 2 },
  updateBtn: { backgroundColor: COLORS.accent, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 9, marginLeft: 10 },
  updateBtnTx: { color: '#fff', fontWeight: '700', fontSize: 12 },

  sectionTitle: { fontSize: 12, fontWeight: '700', color: COLORS.muted, letterSpacing: 1.2, marginBottom: 12 },
  menuRow: { backgroundColor: COLORS.card, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, flexDirection: 'row', alignItems: 'center', paddingVertical: 18, paddingRight: 16, marginBottom: 12 },
  menuBar: { width: 4, alignSelf: 'stretch', backgroundColor: COLORS.primary, borderTopLeftRadius: 8, borderBottomLeftRadius: 8, marginRight: 16, marginVertical: -18 },
  menuTitle: { fontSize: 16, fontWeight: '600', color: COLORS.text },
  menuSub: { fontSize: 12, color: COLORS.muted, marginTop: 3 },
  menuArrow: { fontSize: 26, color: COLORS.muted },
  footer: { textAlign: 'center', color: COLORS.muted, fontSize: 11, position: 'absolute', bottom: 24, left: 0, right: 0, letterSpacing: 0.5 },

  card: { backgroundColor: COLORS.card, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, padding: 16, marginBottom: 14 },
  cardTitle: { fontSize: 11, fontWeight: '700', color: COLORS.primary, letterSpacing: 1.1, marginBottom: 14 },
  label: { fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: '600' },
  input: { backgroundColor: '#FAFBFC', borderWidth: 1, borderColor: COLORS.border, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, color: COLORS.text },
  tips: { backgroundColor: '#EEF2F7', borderLeftWidth: 3, borderLeftColor: COLORS.primary, borderRadius: 4, padding: 14, marginBottom: 18 },
  tipsTitle: { fontWeight: '700', color: COLORS.primary, marginBottom: 6, fontSize: 13 },
  tipsTx: { color: COLORS.text, fontSize: 12, marginTop: 3 },

  btn: { backgroundColor: COLORS.primary, borderRadius: 6, paddingVertical: 15, alignItems: 'center' },
  btnOutline: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: COLORS.primary },
  btnDanger: { backgroundColor: COLORS.err },
  btnTx: { color: '#fff', fontSize: 15, fontWeight: '600', letterSpacing: 0.4 },

  camTop: { position: 'absolute', top: 0, left: 0, right: 0, height: TOP_BAR_H, backgroundColor: 'rgba(12,34,56,0.88)', paddingTop: TOP, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  camTitle: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  camSub: { color: '#B8C7D9', fontSize: 12, marginTop: 2 },
  topBtn: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8, marginLeft: 8 },
  topBtnTx: { color: '#fff', fontSize: 12, fontWeight: '600' },
  frame: { position: 'absolute', left: 12, right: 12, top: TOP_BAR_H + 8, height: H - TOP_BAR_H - PANEL_H - 16, borderRadius: 26, borderWidth: 4 },
  camBottom: { position: 'absolute', left: 0, right: 0, top: H - PANEL_H, height: PANEL_H, backgroundColor: 'rgba(12,34,56,0.88)', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, justifyContent: 'space-between' },
  camMsg: { color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center', minHeight: 44 },
  camDbg: { color: '#FBBF24', fontSize: 10, marginTop: 2, textAlign: 'center' },
  stepsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stepItem: { alignItems: 'center', width: 56 },
  stepDot: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center' },
  stepDotDone: { backgroundColor: COLORS.ok, borderColor: COLORS.ok },
  stepDotNow: { borderColor: '#F6C453' },
  stepNum: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 5 },

  resCircle: { width: 84, height: 84, borderRadius: 42, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  resSymbol: { color: '#fff', fontSize: 42, fontWeight: '700' },
  resTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 16 },
  resName: { textAlign: 'center', color: COLORS.muted, marginTop: 6, fontSize: 14 },
  detailBox: { backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, padding: 12, marginVertical: 18 },
  detailLabel: { fontSize: 10, fontWeight: '700', color: COLORS.muted, letterSpacing: 1, marginBottom: 6 },
  detail: { color: COLORS.text, fontSize: 12 },

  row: { backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, padding: 14, flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  rowName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  rowSub: { fontSize: 11, color: COLORS.muted, marginTop: 3 },
  rowStatus: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  empty: { textAlign: 'center', color: COLORS.muted, marginTop: 40 },
});