import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Pressable, StyleSheet, ScrollView, Alert,
  Vibration, Animated, Easing, ActivityIndicator, StatusBar, Platform,
  KeyboardAvoidingView, Dimensions, Linking, useColorScheme,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';

// Configuration comes from the .env file through app.config.js
const extra = (Constants.expoConfig && Constants.expoConfig.extra) || {};
const SERVER = extra.server || '';
const TOKEN = extra.token || '';
const GITHUB_REPO = extra.githubRepo || '';
const DEBUG = !!extra.debug;
const VERSION = (Constants.expoConfig && Constants.expoConfig.version) || '1.0.0';

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
const PANEL_H = 184;
// oval face guide, centred between the top bar and the bottom panel
const AVAIL_H = H - TOP_BAR_H - PANEL_H;
const GUIDE_H = Math.min(AVAIL_H - 60, W * 0.8 * 1.3);
const GUIDE_W = GUIDE_H / 1.3;
const GUIDE_TOP = TOP_BAR_H + (AVAIL_H - GUIDE_H) / 2;
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

// ---------- themes (follow the phone, with a manual override) ----------
const LIGHT = {
  bg: '#EDF1F7', card: '#FFFFFF', cardEdge: '#CFD8E4', border: '#E1E7EF',
  text: '#15202B', muted: '#64748B', placeholder: '#94A3B8', input: '#F5F7FB', tile: '#E4EBF4',
  hero: '#14324F', primary: '#1B4672', primaryEdge: '#0B2540', primarySoft: '#14324F',
  accent: '#D69E2E', accentEdge: '#A87414',
  ok: '#16A34A', okEdge: '#0F7A37', err: '#DC2626', errEdge: '#A31919',
  okBg: '#DCFCE7', errBg: '#FEE2E2', warnBg: '#FEF3C7', warnTx: '#92400E',
  shadow: '#0C2238', shadowOp: 0.14,
};
const DARK = {
  bg: '#0A111C', card: '#142033', cardEdge: '#070C14', border: '#22334A',
  text: '#E8EEF6', muted: '#8FA3BA', placeholder: '#5B7089', input: '#0E1827', tile: '#1D2F47',
  hero: '#0F1B2D', primary: '#2F7DD1', primaryEdge: '#1A4E8C', primarySoft: '#8DBBF2',
  accent: '#F2B84B', accentEdge: '#B9821C',
  ok: '#4ADE80', okEdge: '#1F9D55', err: '#F87171', errEdge: '#B83A3A',
  okBg: 'rgba(74,222,128,0.16)', errBg: 'rgba(248,113,113,0.16)', warnBg: '#33290F', warnTx: '#FCD34D',
  shadow: '#000000', shadowOp: 0.5,
};

const ThemeCtx = createContext(null);
const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }) {
  const sys = useColorScheme();
  const [mode, setMode] = useState('auto'); // auto | light | dark
  useEffect(() => {
    AsyncStorage.getItem('themeMode').then((v) => {
      if (v === 'auto' || v === 'light' || v === 'dark') setMode(v);
    }).catch(() => {});
  }, []);
  const dark = mode === 'auto' ? sys === 'dark' : mode === 'dark';
  const C = dark ? DARK : LIGHT;
  const st = useMemo(() => makeStyles(C), [dark]);
  const value = useMemo(() => ({
    C, st, dark, mode,
    cycle: () => {
      const n = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
      setMode(n);
      AsyncStorage.setItem('themeMode', n).catch(() => {});
    },
  }), [dark, mode]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

// ---------- animation helpers ----------
const Reveal = ({ delay = 0, children, style }) => {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 520, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View style={[style, { opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
};

const Float = ({ amp = 8, duration = 3200, children, style }) => {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(a, { toValue: 0, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, []);
  return (
    <Animated.View style={[style, { transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [-amp, amp] }) }] }]}>
      {children}
    </Animated.View>
  );
};

// slowly turns left/right with perspective (3D feel)
const Spin3D = ({ children, style }) => {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(a, { toValue: 0, duration: 2600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, []);
  return (
    <Animated.View style={[style, { transform: [{ perspective: 700 }, { rotateY: a.interpolate({ inputRange: [0, 1], outputRange: ['-22deg', '22deg'] }) }, { rotateX: a.interpolate({ inputRange: [0, 1], outputRange: ['6deg', '-6deg'] }) }] }]}>
      {children}
    </Animated.View>
  );
};

const CountUp = ({ value, style }) => {
  const a = useRef(new Animated.Value(0)).current;
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = a.addListener(({ value: v }) => setN(Math.round(v)));
    Animated.timing(a, { toValue: value, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return () => a.removeListener(id);
  }, [value]);
  return <Text style={style}>{n}</Text>;
};

const ScanLine = ({ h, color }) => {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const l = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(a, { toValue: 0, duration: 1700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    l.start();
    return () => l.stop();
  }, []);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute', left: 0, right: 0, height: 3, backgroundColor: color, opacity: 0.85,
        shadowColor: color, shadowOpacity: 1, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
        transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, h - 3] }) }],
      }}
    />
  );
};

// ---------- 3D building blocks ----------
// A solid "edge" under a face. On press the face sinks into the edge, like a real key.
const Raised = ({ onPress, disabled, depth = 5, radius = 18, edgeColor, faceStyle, style, children }) => {
  const { st } = useTheme();
  const a = useRef(new Animated.Value(0)).current;
  const to = (v) => Animated.spring(a, { toValue: v, useNativeDriver: true, speed: 50, bounciness: 5 }).start();
  return (
    <Pressable onPressIn={() => to(1)} onPressOut={() => to(0)} onPress={onPress} disabled={disabled} style={style}>
      <View style={{ paddingBottom: depth }}>
        <View style={[st.edge, { top: depth, borderRadius: radius, backgroundColor: edgeColor }]} />
        <Animated.View
          style={[
            { borderRadius: radius },
            faceStyle,
            { transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, depth - 1] }) }] },
          ]}
        >
          {children}
        </Animated.View>
      </View>
    </Pressable>
  );
};

const Card3D = ({ children, style, depth = 4, radius = 20, pad = 18 }) => {
  const { C, st } = useTheme();
  return (
    <View style={[{ paddingBottom: depth }, style]}>
      <View style={[st.edge, { top: depth, borderRadius: radius, backgroundColor: C.cardEdge }]} />
      <View style={{ backgroundColor: C.card, borderRadius: radius, padding: pad }}>{children}</View>
    </View>
  );
};

// ---------- small components ----------
const Btn = ({ title, onPress, kind = 'primary', disabled, icon }) => {
  const { C, st } = useTheme();
  const outline = kind === 'outline';
  const face = outline
    ? { backgroundColor: C.card, borderWidth: 1.5, borderColor: C.primarySoft }
    : { backgroundColor: kind === 'danger' ? C.err : C.primary };
  const edge = outline ? C.cardEdge : kind === 'danger' ? C.errEdge : C.primaryEdge;
  const tx = outline ? C.primarySoft : '#fff';
  return (
    <Raised onPress={onPress} disabled={disabled} radius={16} depth={5} edgeColor={edge}
      faceStyle={[st.btnFace, face]} style={disabled ? { opacity: 0.5 } : null}>
      {icon ? <Ionicons name={icon} size={18} color={tx} style={{ marginRight: 8 }} /> : null}
      <Text style={[st.btnTx, { color: tx }]}>{title}</Text>
    </Raised>
  );
};

const Field = ({ label, error, icon, ...p }) => {
  const { C, st } = useTheme();
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={st.label}>{label}</Text>
      <View style={[st.inputWrap, focus && { borderColor: C.accent, backgroundColor: C.card }, error && { borderColor: C.err }]}>
        {icon ? <Ionicons name={icon} size={18} color={focus ? C.accent : C.muted} style={{ marginRight: 10 }} /> : null}
        <TextInput
          style={st.input}
          placeholderTextColor={C.placeholder}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          {...p}
        />
      </View>
    </View>
  );
};

const Header = ({ title, onBack }) => {
  const { st } = useTheme();
  return (
    <View style={st.header}>
      {onBack ? (
        <Pressable onPress={onBack} style={st.backBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </Pressable>
      ) : null}
      <Text style={st.headerTx}>{title}</Text>
    </View>
  );
};

const Stat = ({ value, label, icon, color, delay }) => {
  const { C, st } = useTheme();
  return (
    <Reveal delay={delay} style={{ flex: 1 }}>
      <Raised radius={20} depth={5} edgeColor={C.cardEdge} faceStyle={st.statFace} style={{ marginHorizontal: 5 }}>
        <View style={[st.statIcon, { backgroundColor: C.tile }]}>
          <Ionicons name={icon} size={16} color={color || C.primarySoft} />
        </View>
        <CountUp value={value} style={[st.statVal, color && { color }]} />
        <Text style={st.statLbl}>{label}</Text>
      </Raised>
    </Reveal>
  );
};

const MenuRow = ({ title, sub, onPress, icon }) => {
  const { C, st } = useTheme();
  return (
    <Raised onPress={onPress} radius={20} depth={5} edgeColor={C.cardEdge} faceStyle={st.menuFace} style={{ marginBottom: 12 }}>
      <View style={st.menuIcon}><Ionicons name={icon} size={22} color={C.primarySoft} /></View>
      <View style={{ flex: 1 }}>
        <Text style={st.menuTitle}>{title}</Text>
        <Text style={st.menuSub}>{sub}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={C.muted} />
    </Raised>
  );
};

const HeroLogo = () => {
  const { C, st } = useTheme();
  return (
    <Spin3D>
      <View style={[st.logoTile, { backgroundColor: C.accent, borderBottomColor: C.accentEdge }]}>
        <Ionicons name="scan" size={40} color="#fff" />
        <Ionicons name="person" size={20} color="#fff" style={{ position: 'absolute' }} />
      </View>
    </Spin3D>
  );
};

const ThemeToggle = () => {
  const { st, mode, cycle } = useTheme();
  const icon = mode === 'auto' ? 'contrast' : mode === 'light' ? 'sunny' : 'moon';
  const label = mode === 'auto' ? 'Auto' : mode === 'light' ? 'Light' : 'Dark';
  return (
    <Pressable onPress={cycle} style={st.themeBtn} hitSlop={6}>
      <Ionicons name={icon} size={15} color="#fff" />
      <Text style={st.themeTx}>{label}</Text>
    </Pressable>
  );
};

const ResultBadge = ({ ok }) => {
  const { C, st } = useTheme();
  const pop = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(pop, { toValue: 1, friction: 4, tension: 80, useNativeDriver: true }).start();
    const l = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 1700, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, []);
  const col = ok ? C.ok : C.err;
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', height: 150 }}>
      <Animated.View
        style={{
          position: 'absolute', width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: col,
          opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
          transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
        }}
      />
      <Animated.View style={[st.resCircle, { backgroundColor: col, borderBottomColor: ok ? C.okEdge : C.errEdge, transform: [{ scale: pop }] }]}>
        <Ionicons name={ok ? 'checkmark' : 'close'} size={50} color="#fff" />
      </Animated.View>
    </View>
  );
};

function Main() {
  const { C, st, dark } = useTheme();
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
  const flash = useRef(new Animated.Value(0)).current;

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
    addHistory({ id: f.employee_id, name: f.employee_name, ok, time: new Date().toLocaleString(), ts: Date.now() });
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
        if (captured) {
          Vibration.vibrate(120);
          flash.setValue(0.8);
          Animated.timing(flash, { toValue: 0, duration: 380, useNativeDriver: true }).start();
        }
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

  // ---------- CAMERA ----------
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
          <Pressable style={[st.topBtn, got > 0 && { opacity: 0.35 }]} onPress={flip} disabled={got > 0}>
            <Ionicons name="camera-reverse" size={15} color="#fff" />
            <Text style={st.topBtnTx}>Flip</Text>
          </Pressable>
          <Pressable style={st.topBtn} onPress={cancel}>
            <Ionicons name="close" size={15} color="#fff" />
            <Text style={st.topBtnTx}>Cancel</Text>
          </Pressable>
        </View>

        <View pointerEvents="none" style={[st.glow, { borderColor: frameColor }]} />
        <Animated.View
          pointerEvents="none"
          style={[
            st.guide,
            {
              borderColor: frameColor,
              backgroundColor: match ? 'rgba(34,197,94,0.12)' : 'transparent',
              transform: [{ scale: pulse }],
            },
          ]}
        >
          {!match ? <ScanLine h={GUIDE_H} color={FRAME_OK} /> : null}
        </Animated.View>

        <View pointerEvents="none" style={st.stepPill}>
          <Text style={st.stepPillTx}>
            Step {Math.min(got + 1, STEPS.length)} of {STEPS.length}  ·  {STEPS[Math.min(got, STEPS.length - 1)].label}
          </Text>
        </View>

        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: flash }]} />

        <View style={st.camBottom}>
          <View style={st.progressTrack}>
            <View style={[st.progressFill, { width: `${(got / STEPS.length) * 100}%` }]} />
          </View>
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
                    {done ? <Ionicons name="checkmark" size={16} color="#fff" /> : <Text style={st.stepNum}>{i + 1}</Text>}
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

  // ---------- RESULT ----------
  if (screen === 'result') {
    return (
      <View style={st.center}>
        <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
        <ResultBadge ok={result.ok} />
        <Reveal delay={150}>
          <Text style={[st.resTitle, { color: result.ok ? C.ok : C.err }]}>
            {result.ok ? 'Enrollment Successful' : 'Enrollment Failed'}
          </Text>
          <Text style={st.resName}>{f.employee_name}  |  ID {f.employee_id}</Text>
        </Reveal>
        <Reveal delay={260}>
          <Card3D style={{ marginVertical: 20 }} pad={14}>
            <Text style={st.detailLabel}>SERVER RESPONSE</Text>
            <ScrollView style={{ maxHeight: 110 }}>
              <Text style={st.detail}>{String(result.text).slice(0, 600)}</Text>
            </ScrollView>
          </Card3D>
        </Reveal>
        <Reveal delay={360}>
          {!result.ok ? <Btn title="Try Again" icon="refresh" onPress={start} /> : null}
          <View style={{ height: 10 }} />
          <Btn
            title={result.ok ? 'New Enrollment' : 'Edit Details'}
            icon={result.ok ? 'person-add' : 'create'}
            kind={result.ok ? 'primary' : 'outline'}
            onPress={result.ok ? newEnrollment : () => setScreen('form')}
          />
          <View style={{ height: 10 }} />
          <Btn title="Back to Home" icon="home" kind="outline" onPress={() => setScreen('home')} />
        </Reveal>
      </View>
    );
  }

  // ---------- FORM ----------
  if (screen === 'form') {
    return (
      <View style={st.page}>
        <StatusBar barStyle="light-content" />
        <Header title="Employee Details" onBack={() => setScreen('home')} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ padding: 18 }} keyboardShouldPersistTaps="handled">
            <Reveal>
              <Card3D style={{ marginBottom: 14 }}>
                <Text style={st.cardTitle}>REQUIRED INFORMATION</Text>
                <Field label="Employee ID" icon="id-card" placeholder="000000" keyboardType="number-pad"
                  error={tried && !f.employee_id.trim()}
                  value={f.employee_id} onChangeText={(t) => setF({ ...f, employee_id: t })} />
                <Field label="Card No" icon="card" placeholder="000000" keyboardType="number-pad"
                  error={tried && !f.employee_card_no.trim()}
                  value={f.employee_card_no} onChangeText={(t) => setF({ ...f, employee_card_no: t })} />
                <Field label="Full Name" icon="person" placeholder="Zain Akram"
                  error={tried && !f.employee_name.trim()}
                  value={f.employee_name} onChangeText={(t) => setF({ ...f, employee_name: t })} />
              </Card3D>
            </Reveal>

            <Reveal delay={120}>
              <Card3D style={{ marginBottom: 14 }}>
                <Text style={st.cardTitle}>ORGANIZATION DETAILS (OPTIONAL)</Text>
                <Field label="Department" icon="business" placeholder="Information Technology"
                  value={f.deptt_name} onChangeText={(t) => setF({ ...f, deptt_name: t })} />
                <Field label="Section" icon="layers" placeholder="Development and Support"
                  value={f.section_name} onChangeText={(t) => setF({ ...f, section_name: t })} />
                <Field label="Designation" icon="briefcase" placeholder="MTO"
                  value={f.designation_name} onChangeText={(t) => setF({ ...f, designation_name: t })} />
              </Card3D>
            </Reveal>

            <Reveal delay={220}>
              <View style={st.tips}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                  <Ionicons name="bulb" size={16} color={C.accent} />
                  <Text style={st.tipsTitle}>Guidelines</Text>
                </View>
                <Text style={st.tipsTx}>• Use good lighting and avoid strong light from behind</Text>
                <Text style={st.tipsTx}>• Remove cap, mask and glasses</Text>
                <Text style={st.tipsTx}>• Keep the phone steady, at face level</Text>
                <Text style={st.tipsTx}>• Turn the head slowly and pause until the frame turns green</Text>
              </View>
              <Btn title="Start Face Capture" icon="camera" onPress={start} />
            </Reveal>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ---------- HISTORY ----------
  if (screen === 'history') {
    return (
      <View style={st.page}>
        <StatusBar barStyle="light-content" />
        <Header title="Enrollment History" onBack={() => setScreen('home')} />
        <ScrollView contentContainerStyle={{ padding: 18 }}>
          {history.length === 0 ? <Text style={st.empty}>No enrollments recorded yet.</Text> : null}
          {history.map((h, i) => (
            <Reveal key={i} delay={Math.min(i, 8) * 50}>
              <Card3D style={{ marginBottom: 10 }} depth={3} radius={16} pad={14}>
                <View style={st.rowIn}>
                  <View style={[st.avatar, { backgroundColor: h.ok ? C.okBg : C.errBg }]}>
                    <Text style={[st.avatarTx, { color: h.ok ? C.ok : C.err }]}>{(h.name || '?').trim().charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={st.rowName} numberOfLines={1}>{h.name}</Text>
                    <Text style={st.rowSub}>ID {h.id}  |  {h.time}</Text>
                  </View>
                  <View style={[st.pill, { backgroundColor: h.ok ? C.okBg : C.errBg }]}>
                    <Text style={[st.pillTx, { color: h.ok ? C.ok : C.err }]}>{h.ok ? 'SUCCESS' : 'FAILED'}</Text>
                  </View>
                </View>
              </Card3D>
            </Reveal>
          ))}
          {history.length > 0 ? <View style={{ marginTop: 10 }}><Btn title="Clear History" icon="trash" kind="danger" onPress={clearHistory} /></View> : null}
        </ScrollView>
      </View>
    );
  }

  // ---------- HOME ----------
  const todayStr = new Date().toDateString();
  const todayCount = history.filter((h) => h.ts && new Date(h.ts).toDateString() === todayStr).length;
  const okCount = history.filter((h) => h.ok).length;
  const failCount = history.length - okCount;
  const recent = history.slice(0, 3);

  return (
    <View style={st.page}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={{ paddingBottom: 30 }} showsVerticalScrollIndicator={false}>
        <View style={st.hero}>
          <Float amp={10} duration={3600} style={[st.orb, { width: 170, height: 170, right: -50, top: -30, backgroundColor: 'rgba(255,255,255,0.06)' }]} />
          <Float amp={7} duration={2800} style={[st.orb, { width: 90, height: 90, left: -25, bottom: 30, backgroundColor: 'rgba(214,158,46,0.16)' }]} />
          <Float amp={6} duration={3000} style={[st.orb, { width: 46, height: 46, right: 90, bottom: 44, backgroundColor: 'rgba(255,255,255,0.08)' }]} />

          <View style={st.heroTop}>
            <HeroLogo />
            <ThemeToggle />
          </View>
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

        <View style={st.statsRow}>
          <Stat value={todayCount} label="Today" icon="today" delay={80} />
          <Stat value={okCount} label="Successful" icon="checkmark-circle" color={C.ok} delay={160} />
          <Stat value={failCount} label="Failed" icon="close-circle" color={failCount > 0 ? C.err : C.muted} delay={240} />
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
          {update ? (
            <Reveal>
              <Raised onPress={() => Linking.openURL(update.url)} radius={18} depth={5} edgeColor={C.accentEdge}
                faceStyle={[st.updateFace, { backgroundColor: C.warnBg }]} style={{ marginBottom: 20 }}>
                <Ionicons name="cloud-download" size={26} color={C.accent} style={{ marginRight: 12 }} />
                <View style={{ flex: 1 }}>
                  <Text style={[st.updateTitle, { color: C.warnTx }]}>Update available: version {update.version}</Text>
                  <Text style={[st.updateSub, { color: C.warnTx }]}>You are using version {VERSION}. Tap to download.</Text>
                </View>
              </Raised>
            </Reveal>
          ) : null}

          <Text style={st.sectionTitle}>QUICK ACTIONS</Text>
          <Reveal delay={200}>
            <Raised onPress={newEnrollment} radius={22} depth={6} edgeColor={C.primaryEdge}
              faceStyle={st.ctaFace} style={{ marginBottom: 14 }}>
              <View style={st.ctaIcon}><Ionicons name="person-add" size={26} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={st.ctaTitle}>New Enrollment</Text>
                <Text style={st.ctaSub}>Register an employee's face</Text>
              </View>
              <Ionicons name="arrow-forward-circle" size={30} color="rgba(255,255,255,0.9)" />
            </Raised>
          </Reveal>
          <Reveal delay={280}>
            <MenuRow icon="time" title="Enrollment History" sub={`${history.length} records on this device`} onPress={() => setScreen('history')} />
          </Reveal>

          {recent.length > 0 ? (
            <View style={{ marginTop: 10 }}>
              <View style={st.recentHead}>
                <Text style={st.sectionTitle}>RECENT</Text>
                <TouchableOpacity onPress={() => setScreen('history')}>
                  <Text style={st.linkTx}>View all</Text>
                </TouchableOpacity>
              </View>
              {recent.map((h, i) => (
                <Reveal key={i} delay={340 + i * 70}>
                  <Card3D style={{ marginBottom: 10 }} depth={3} radius={16} pad={14}>
                    <View style={st.rowIn}>
                      <View style={[st.avatar, { backgroundColor: h.ok ? C.okBg : C.errBg }]}>
                        <Text style={[st.avatarTx, { color: h.ok ? C.ok : C.err }]}>{(h.name || '?').trim().charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={st.rowName} numberOfLines={1}>{h.name}</Text>
                        <Text style={st.rowSub}>ID {h.id}  |  {h.time}</Text>
                      </View>
                      <View style={[st.pill, { backgroundColor: h.ok ? C.okBg : C.errBg }]}>
                        <Text style={[st.pillTx, { color: h.ok ? C.ok : C.err }]}>{h.ok ? 'SUCCESS' : 'FAILED'}</Text>
                      </View>
                    </View>
                  </Card3D>
                </Reveal>
              ))}
            </View>
          ) : null}
        </View>
        <Text style={st.footer}>SM FaceID  |  Version {VERSION}</Text>
      </ScrollView>
    </View>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Main />
    </ThemeProvider>
  );
}

const makeStyles = (C) => StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', padding: 24 },

  // shared 3D edge (sits under a face, peeks out at the bottom)
  edge: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    shadowColor: C.shadow, shadowOpacity: C.shadowOp, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4,
  },

  header: { backgroundColor: C.hero, paddingTop: TOP, paddingBottom: 22, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderBottomLeftRadius: 28, borderBottomRightRadius: 28 },
  headerTx: { color: '#fff', fontSize: 19, fontWeight: '700', letterSpacing: 0.3 },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center', marginRight: 12 },

  hero: { backgroundColor: C.hero, paddingTop: TOP + 12, paddingBottom: 66, paddingHorizontal: 22, borderBottomLeftRadius: 38, borderBottomRightRadius: 38, overflow: 'hidden' },
  orb: { position: 'absolute', borderRadius: 100 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  logoTile: { width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 5 },
  themeBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 },
  themeTx: { color: '#fff', fontSize: 11, fontWeight: '700', marginLeft: 6, letterSpacing: 0.4 },
  company: { color: '#fff', fontSize: 30, fontWeight: '800', letterSpacing: 4 },
  product: { color: '#B8C7D9', fontSize: 14, marginTop: 4, letterSpacing: 0.5 },
  badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.14)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, marginTop: 18 },
  badgeTx: { color: '#fff', marginLeft: 8, fontSize: 12 },
  dot: { width: 9, height: 9, borderRadius: 5 },

  statsRow: { flexDirection: 'row', paddingHorizontal: 15, marginTop: -42, marginBottom: 14 },
  statFace: { backgroundColor: C.card, paddingVertical: 14, alignItems: 'center' },
  statIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  statVal: { fontSize: 26, fontWeight: '800', color: C.text },
  statLbl: { fontSize: 11, color: C.muted, marginTop: 2, fontWeight: '600', letterSpacing: 0.4 },

  updateFace: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  updateTitle: { fontWeight: '700', fontSize: 13 },
  updateSub: { fontSize: 11, marginTop: 2 },

  sectionTitle: { fontSize: 12, fontWeight: '700', color: C.muted, letterSpacing: 1.2, marginBottom: 12 },
  recentHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  linkTx: { color: C.accent, fontSize: 12, fontWeight: '700' },

  ctaFace: { backgroundColor: C.primary, flexDirection: 'row', alignItems: 'center', padding: 16 },
  ctaIcon: { width: 54, height: 54, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  ctaTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  ctaSub: { color: 'rgba(255,255,255,0.78)', fontSize: 12, marginTop: 3 },
  menuFace: { backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', padding: 14 },
  menuIcon: { width: 46, height: 46, borderRadius: 14, backgroundColor: C.tile, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  menuTitle: { fontSize: 16, fontWeight: '600', color: C.text },
  menuSub: { fontSize: 12, color: C.muted, marginTop: 3 },
  footer: { textAlign: 'center', color: C.muted, fontSize: 11, marginTop: 26, letterSpacing: 0.5 },

  cardTitle: { fontSize: 11, fontWeight: '700', color: C.primarySoft, letterSpacing: 1.1, marginBottom: 14 },
  label: { fontSize: 12, color: C.muted, marginBottom: 6, fontWeight: '600' },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.input, borderWidth: 1.5, borderColor: C.border, borderRadius: 14, paddingHorizontal: 12 },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: C.text },
  tips: { backgroundColor: C.tile, borderRadius: 18, padding: 16, marginBottom: 18 },
  tipsTitle: { fontWeight: '700', color: C.text, marginLeft: 6, fontSize: 13 },
  tipsTx: { color: C.text, fontSize: 12, marginTop: 3, opacity: 0.85 },

  btnFace: { paddingVertical: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  btnTx: { fontSize: 15, fontWeight: '700', letterSpacing: 0.4 },

  camTop: { position: 'absolute', top: 0, left: 0, right: 0, height: TOP_BAR_H, backgroundColor: 'rgba(12,34,56,0.88)', paddingTop: TOP, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
  camTitle: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  camSub: { color: '#B8C7D9', fontSize: 12, marginTop: 2 },
  topBtn: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, marginLeft: 8 },
  topBtnTx: { color: '#fff', fontSize: 12, fontWeight: '600', marginLeft: 5 },
  glow: { position: 'absolute', left: (W - GUIDE_W) / 2 - 8, top: GUIDE_TOP - 8, width: GUIDE_W + 16, height: GUIDE_H + 16, borderRadius: (GUIDE_W + 16) / 2, borderWidth: 6, opacity: 0.25 },
  guide: { position: 'absolute', left: (W - GUIDE_W) / 2, top: GUIDE_TOP, width: GUIDE_W, height: GUIDE_H, borderRadius: GUIDE_W / 2, borderWidth: 4, overflow: 'hidden' },
  stepPill: { position: 'absolute', top: TOP_BAR_H + 8, alignSelf: 'center', backgroundColor: 'rgba(12,34,56,0.78)', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6 },
  stepPillTx: { color: '#fff', fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },
  camBottom: { position: 'absolute', left: 0, right: 0, top: H - PANEL_H, height: PANEL_H, backgroundColor: 'rgba(12,34,56,0.92)', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, justifyContent: 'space-between', borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  progressTrack: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: FRAME_OK },
  camMsg: { color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center', minHeight: 44 },
  camDbg: { color: '#FBBF24', fontSize: 10, marginTop: 2, textAlign: 'center' },
  stepsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stepItem: { alignItems: 'center', width: 56 },
  stepDot: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center' },
  stepDotDone: { backgroundColor: '#16A34A', borderColor: '#16A34A' },
  stepDotNow: { borderColor: '#F6C453' },
  stepNum: { color: '#fff', fontSize: 13, fontWeight: '700' },
  stepLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 5 },

  resCircle: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 6 },
  resTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  resName: { textAlign: 'center', color: C.muted, marginTop: 6, fontSize: 14 },
  detailLabel: { fontSize: 10, fontWeight: '700', color: C.muted, letterSpacing: 1, marginBottom: 6 },
  detail: { color: C.text, fontSize: 12 },

  rowIn: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarTx: { fontSize: 16, fontWeight: '700' },
  rowName: { fontSize: 15, fontWeight: '600', color: C.text },
  rowSub: { fontSize: 11, color: C.muted, marginTop: 3 },
  pill: { borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4, marginLeft: 8 },
  pillTx: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  empty: { textAlign: 'center', color: C.muted, marginTop: 40 },
});
