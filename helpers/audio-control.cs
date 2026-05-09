// audio-control.cs — RoomReady Windows audio helper
//
// Geeft Core Audio COM-functies (volume + mute lezen/zetten) aan de Electron
// main-process via een short-lived child process. Eén invocatie per actie:
// COM is altijd CoCreate'd en CoUninit'd binnen ~ms, geen blijvende handles,
// geen callbacks/subscriptions, geen AudioServiceOutOfProcess.
//
// Compile (one-shot, dev-time):
//   csc.exe /nologo /target:exe /platform:x64 /out:audio-control.exe audio-control.cs
//
// CLI:
//   audio-control list                       — JSON array van alle actieve endpoints
//   audio-control get-defaults               — {render:id, capture:id}
//   audio-control get <id>                   — JSON object voor één endpoint
//   audio-control set-volume <id> <0..100>   — exit 0 op succes
//   audio-control set-mute <id> <true|false> — exit 0 op succes
//
// Exit codes: 0 OK, 1 onverwachte exception, 2 usage-fout, 3 device niet gevonden.

using System;
using System.Runtime.InteropServices;
using System.Text;

namespace RoomReady.AudioHelper {
    static class Program {
        const int eRender = 0;
        const int eCapture = 1;
        const int eConsole = 0;
        const uint DEVICE_STATE_ACTIVE = 0x1;
        const uint STGM_READ = 0;
        const uint CLSCTX_ALL = 23;
        const ushort VT_LPWSTR = 31;

        // PKEY_Device_FriendlyName
        static readonly Guid PKEY_FriendlyName_GUID = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");

        // Eigen GUID — gebruikt als event-context bij set calls. Voorkomt feedback-
        // loops als ergens later een notifier wordt geregistreerd.
        static Guid eventContext = new Guid("4f49e30b-0a3a-4b6f-b1c5-1d2e3f405060");

        [StructLayout(LayoutKind.Sequential)]
        struct PROPERTYKEY { public Guid fmtid; public uint pid; }

        [StructLayout(LayoutKind.Sequential)]
        struct PROPVARIANT {
            public ushort vt;
            public ushort wReserved1;
            public ushort wReserved2;
            public ushort wReserved3;
            public IntPtr ptr;
            public IntPtr ptr2;
        }

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT pvar);

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        class MMDeviceEnumerator { }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
            int EnumAudioEndpoints(int dataFlow, uint stateMask, out IMMDeviceCollection devices);
            int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            // Skip rest — vtable order maakt niet uit voor niet-aangeroepen methods.
        }

        [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceCollection {
            int GetCount(out uint count);
            int Item(uint index, out IMMDevice device);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
            int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams,
                         [MarshalAs(UnmanagedType.IUnknown)] out object pInterface);
            int OpenPropertyStore(uint stgmAccess, out IPropertyStore properties);
            int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            int GetState(out uint state);
        }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPropertyStore {
            int GetCount(out uint count);
            int GetAt(uint index, out PROPERTYKEY key);
            int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        }

        [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
         InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
            // Vtable-order — alle slots tot SetMute/GetMute moeten voorkomen.
            int RegisterControlChangeNotify(IntPtr cb);
            int UnregisterControlChangeNotify(IntPtr cb);
            int GetChannelCount(out uint count);
            int SetMasterVolumeLevel(float fLevelDB, ref Guid eventContext);
            int SetMasterVolumeLevelScalar(float fLevel, ref Guid eventContext);
            int GetMasterVolumeLevel(out float fLevelDB);
            int GetMasterVolumeLevelScalar(out float fLevel);
            int SetChannelVolumeLevel(uint channel, float fLevelDB, ref Guid eventContext);
            int SetChannelVolumeLevelScalar(uint channel, float fLevel, ref Guid eventContext);
            int GetChannelVolumeLevel(uint channel, out float fLevelDB);
            int GetChannelVolumeLevelScalar(uint channel, out float fLevel);
            int SetMute(bool bMute, ref Guid eventContext);
            int GetMute(out bool bMute);
        }

        static IAudioEndpointVolume GetVolume(IMMDevice dev) {
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            int hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
            if (hr < 0) throw new COMException("IMMDevice.Activate", hr);
            return (IAudioEndpointVolume)o;
        }

        static string GetFriendlyName(IMMDevice dev) {
            IPropertyStore store;
            if (dev.OpenPropertyStore(STGM_READ, out store) < 0) return "(unknown)";
            try {
                PROPERTYKEY key = new PROPERTYKEY { fmtid = PKEY_FriendlyName_GUID, pid = 14 };
                PROPVARIANT pv;
                if (store.GetValue(ref key, out pv) < 0) return "(unknown)";
                try {
                    if (pv.vt == VT_LPWSTR && pv.ptr != IntPtr.Zero)
                        return Marshal.PtrToStringUni(pv.ptr) ?? "(null)";
                    return "(no name)";
                } finally { PropVariantClear(ref pv); }
            } finally { Marshal.ReleaseComObject(store); }
        }

        static string GetDevId(IMMDevice dev) {
            string id;
            if (dev.GetId(out id) < 0) throw new COMException("IMMDevice.GetId", -1);
            return id;
        }

        // Zoek een actief endpoint op id, eerst in render-flow, dan capture.
        // Out: dev (release verantwoordelijkheid bij caller) en flow-string.
        static IMMDevice FindDevice(IMMDeviceEnumerator en, string id, out string flow) {
            flow = null;
            int[] flows = { eRender, eCapture };
            string[] flowNames = { "render", "capture" };
            for (int fi = 0; fi < flows.Length; fi++) {
                IMMDeviceCollection coll;
                if (en.EnumAudioEndpoints(flows[fi], DEVICE_STATE_ACTIVE, out coll) < 0) continue;
                try {
                    uint count;
                    coll.GetCount(out count);
                    for (uint i = 0; i < count; i++) {
                        IMMDevice d;
                        if (coll.Item(i, out d) < 0) continue;
                        if (GetDevId(d) == id) { flow = flowNames[fi]; return d; }
                        Marshal.ReleaseComObject(d);
                    }
                } finally { Marshal.ReleaseComObject(coll); }
            }
            return null;
        }

        static string EscapeJson(string s) {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s) {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            sb.Append('"');
            return sb.ToString();
        }

        static string DefaultIdSafe(IMMDeviceEnumerator en, int dataFlow) {
            try {
                IMMDevice d;
                if (en.GetDefaultAudioEndpoint(dataFlow, eConsole, out d) < 0 || d == null) return null;
                try { return GetDevId(d); } finally { Marshal.ReleaseComObject(d); }
            } catch { return null; }
        }

        static string EmitDeviceJson(IMMDevice dev, string id, string flow, bool isDefault) {
            string name = GetFriendlyName(dev);
            int volPct = 0; bool muted = true;
            try {
                IAudioEndpointVolume v = GetVolume(dev);
                try {
                    float scalar; v.GetMasterVolumeLevelScalar(out scalar);
                    bool m; v.GetMute(out m);
                    volPct = (int)Math.Round(scalar * 100);
                    muted = m;
                } finally { Marshal.ReleaseComObject(v); }
            } catch { /* sommige render-endpoints exposen geen IAudioEndpointVolume — laat default 0/muted */ }
            return "{\"id\":" + EscapeJson(id)
                 + ",\"name\":" + EscapeJson(name)
                 + ",\"flow\":\"" + flow + "\""
                 + ",\"volume\":" + volPct
                 + ",\"muted\":" + (muted ? "true" : "false")
                 + ",\"default\":" + (isDefault ? "true" : "false") + "}";
        }

        static int Main(string[] args) {
            try {
                IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                try {
                    string cmd = (args.Length == 0) ? "list" : args[0];

                    if (cmd == "list") {
                        string defR = DefaultIdSafe(en, eRender);
                        string defC = DefaultIdSafe(en, eCapture);
                        StringBuilder sb = new StringBuilder("[");
                        bool first = true;
                        int[] flows = { eRender, eCapture };
                        string[] flowNames = { "render", "capture" };
                        for (int fi = 0; fi < flows.Length; fi++) {
                            IMMDeviceCollection coll;
                            if (en.EnumAudioEndpoints(flows[fi], DEVICE_STATE_ACTIVE, out coll) < 0) continue;
                            try {
                                uint count;
                                coll.GetCount(out count);
                                for (uint i = 0; i < count; i++) {
                                    IMMDevice d;
                                    if (coll.Item(i, out d) < 0) continue;
                                    try {
                                        string id = GetDevId(d);
                                        bool isDef = (flows[fi] == eRender ? id == defR : id == defC);
                                        if (!first) sb.Append(",");
                                        first = false;
                                        sb.Append(EmitDeviceJson(d, id, flowNames[fi], isDef));
                                    } finally { Marshal.ReleaseComObject(d); }
                                }
                            } finally { Marshal.ReleaseComObject(coll); }
                        }
                        sb.Append("]");
                        Console.WriteLine(sb.ToString());
                        return 0;
                    }

                    if (cmd == "get-defaults") {
                        Console.WriteLine("{\"render\":" + EscapeJson(DefaultIdSafe(en, eRender))
                                        + ",\"capture\":" + EscapeJson(DefaultIdSafe(en, eCapture)) + "}");
                        return 0;
                    }

                    if (args.Length < 2) {
                        Console.Error.WriteLine("usage: " + cmd + " <id> [...]");
                        return 2;
                    }
                    string devId = args[1];
                    string flowOut;
                    IMMDevice dev = FindDevice(en, devId, out flowOut);
                    if (dev == null) {
                        Console.Error.WriteLine("device not found: " + devId);
                        return 3;
                    }
                    try {
                        if (cmd == "get") {
                            string defR = DefaultIdSafe(en, eRender);
                            string defC = DefaultIdSafe(en, eCapture);
                            bool isDef = (flowOut == "render" ? devId == defR : devId == defC);
                            Console.WriteLine(EmitDeviceJson(dev, devId, flowOut, isDef));
                            return 0;
                        }
                        IAudioEndpointVolume v = GetVolume(dev);
                        try {
                            if (cmd == "set-volume") {
                                if (args.Length < 3) { Console.Error.WriteLine("usage: set-volume <id> <0..100>"); return 2; }
                                int pct;
                                if (!int.TryParse(args[2], out pct)) { Console.Error.WriteLine("invalid percent"); return 2; }
                                if (pct < 0) pct = 0; if (pct > 100) pct = 100;
                                int hr = v.SetMasterVolumeLevelScalar(pct / 100f, ref eventContext);
                                if (hr < 0) throw new COMException("SetMasterVolumeLevelScalar", hr);
                                return 0;
                            }
                            if (cmd == "set-mute") {
                                if (args.Length < 3) { Console.Error.WriteLine("usage: set-mute <id> <true|false>"); return 2; }
                                bool m;
                                if (!bool.TryParse(args[2], out m)) { Console.Error.WriteLine("invalid bool"); return 2; }
                                int hr = v.SetMute(m, ref eventContext);
                                if (hr < 0) throw new COMException("SetMute", hr);
                                return 0;
                            }
                            Console.Error.WriteLine("unknown command: " + cmd);
                            return 2;
                        } finally { Marshal.ReleaseComObject(v); }
                    } finally { Marshal.ReleaseComObject(dev); }
                } finally { Marshal.ReleaseComObject(en); }
            } catch (Exception ex) {
                Console.Error.WriteLine("ERROR: " + ex.GetType().Name + ": " + ex.Message);
                return 1;
            }
        }
    }
}
