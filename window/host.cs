// The frameless Cat Yoink window: a borderless, always-on-top window that shows media/panel.html
// in WebView2 (the Microsoft Edge WebView2 Runtime that comes with Windows 10/11). No title bar:
// the page is dragged from anywhere on the picture and resized from its edges, and it always stays
// fully on one monitor. It follows its VS Code window: while that is minimized, it hides too.
//
// src/nativeWindow.ts starts it one of two ways:
//  - CatHost.exe, which scripts/build-host.js compiles from this file when the extension is
//    packaged (entry point: Main). It runs from a folder that also holds the WebView2 SDK files.
//  - if that is missing or fails: powershell.exe, which compiles this file with Add-Type on every
//    start and calls CatHost.Run.
// Both use the .NET Framework's C# 5 compiler, so no $"", ?., nameof, out var, => members or await
// in catch/finally. It references window/lib/Microsoft.Web.WebView2.Core.dll
// (scripts/fetch-webview2.js).
//
// stdin, one JSON object per line:
//   {"cmd":"init","html":..,"mediaDir":..,"gifDir":..,"userDataDir":..,"layoutFile":..,"devTools":bool,
//    "codePid":N,"codeExe":"..","minimizeWith":bool}
//                                       always the first line. codePid / codeExe: VS Code's main
//                                       process and exe, whose windows it may follow
//   {"cmd":"show"}  {"cmd":"hide"}      show (without taking focus) or hide the window
//   {"cmd":"post","json":".."}          a message for the page, already JSON
//   {"cmd":"claim"}                     this VS Code window has focus: follow the foreground window
//                                       if it is a VS Code window and none is followed yet
//   {"cmd":"minimizeWith","on":bool}    hide while the followed VS Code window is minimized
//   {"cmd":"quit"}
// stdout, one JSON object per line:
//   {"t":"page","msg":{..}}             a page message this host doesn't handle itself
//   {"t":"closed"}                      the user closed the window (its X, Alt+F4): it is hidden
//   {"t":"log","text":".."}             something worth keeping in window.log
//   {"t":"error","text":".."}           it couldn't start; the process exits next
// The page's sceneReady, dragStart {edge}, dragEnd and close are handled here. The process exits
// when stdin closes, so it never outlives the extension host.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

[assembly: AssemblyTitle("Cat Yoink window")]
[assembly: AssemblyProduct("Cat Yoink")]
// For CatHost.exe: without it the .NET Framework runs an exe with its 4.0 compatibility quirks. The
// WebView2 SDK file it loads is the one built for 4.6.2.
[assembly: TargetFramework(".NETFramework,Version=v4.6.2")]

public static class CatHost
{
    static string libDir;
    static TextWriter stdout;
    static readonly object outLock = new object();
    internal static int exitCode;

    /** CatHost.exe starts here. The WebView2 SDK files sit in its own folder. */
    [STAThread]
    static void Main()
    {
        // A crash goes to window.log (and the extension falls back), not to an error dialog.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        AppDomain.CurrentDomain.UnhandledException += OnUnhandled;
        Run(AppDomain.CurrentDomain.BaseDirectory);
    }

    static void OnUnhandled(object sender, UnhandledExceptionEventArgs e)
    {
        var ex = e.ExceptionObject as Exception;
        string text = ex == null ? "unhandled exception" : ex.GetType().Name + ": " + ex.Message;
        Emit("{\"t\":\"error\",\"text\":" + new JavaScriptSerializer().Serialize(text) + "}");
        Native.TerminateProcess(Native.GetCurrentProcess(), 3);
    }

    /** Milliseconds since this process started (for PowerShell, that includes compiling this file). */
    internal static long SinceStart()
    {
        try
        {
            return (long)(DateTime.Now - Process.GetCurrentProcess().StartTime).TotalMilliseconds;
        }
        catch
        {
            return -1;
        }
    }

    /** `lib`: the folder with Microsoft.Web.WebView2.Core.dll and win-x64/, win-arm64/ loaders. */
    public static void Run(string lib)
    {
        libDir = lib;
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        stdout = output;
        // This assembly references Microsoft.Web.WebView2.Core by name; it lives in lib.
        AppDomain.CurrentDomain.AssemblyResolve += ResolveWebView2;
        Native.UsePerMonitorDpi();
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string init = stdin.ReadLine();
        if (init != null)
        {
            RunWindow(init, stdin);
        }
        lock (outLock)
        {
            output.Flush();
        }
        // Not Environment.Exit: its cleanup can wait forever on the WebView2 COM objects. Everything
        // worth keeping (the layout, our output) is written by now.
        Native.TerminateProcess(Native.GetCurrentProcess(), (uint)exitCode);
    }

    static Assembly ResolveWebView2(object sender, ResolveEventArgs e)
    {
        if (new AssemblyName(e.Name).Name == "Microsoft.Web.WebView2.Core")
        {
            return Assembly.LoadFrom(Path.Combine(libDir, "Microsoft.Web.WebView2.Core.dll"));
        }
        return null;
    }

    // Not inlined, so the WebView2 types are only loaded once the resolver above is in place.
    [MethodImpl(MethodImplOptions.NoInlining)]
    static void RunWindow(string init, StreamReader stdin)
    {
        var json = new JavaScriptSerializer();
        json.MaxJsonLength = int.MaxValue;
        Dictionary<string, object> c;
        try
        {
            c = json.Deserialize<Dictionary<string, object>>(init);
        }
        catch (Exception ex)
        {
            Emit("{\"t\":\"error\",\"text\":" + json.Serialize("bad init line: " + ex.Message) + "}");
            exitCode = 1;
            return;
        }
        var form = new CatForm(libDir, c, json);
        IntPtr unused = form.Handle; // the window exists (hidden) from here on
        var reader = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    string l = line;
                    form.BeginInvoke((MethodInvoker)(() => form.OnCommand(l)));
                }
            }
            catch
            {
                // stdin broke: same as closed
            }
            try
            {
                form.BeginInvoke((MethodInvoker)(() => form.Quit()));
            }
            catch
            {
                // already gone
            }
        });
        reader.IsBackground = true;
        reader.Start();
        // From inside the message loop, so a failure's Quit() (Application.ExitThread) ends it.
        form.BeginInvoke((MethodInvoker)(() => form.Start()));
        Application.Run(new ApplicationContext());
    }

    internal static void Emit(string line)
    {
        lock (outLock)
        {
            try
            {
                stdout.WriteLine(line);
            }
            catch
            {
                // the extension went away (stdin closes next and we quit), or Run() never got to start
            }
        }
    }
}

class CatForm : Form
{
    // DIPs, scaled by the monitor's DPI. Same as the Electron window of earlier versions.
    const int DEFAULT_W = 340, DEFAULT_H = 380, MIN_SIZE = 200, INSET = 24;
    const string PAGE = "https://cat-yoink.page/";
    const int DRAG_TICK_MS = 16;

    readonly string libDir;
    readonly JavaScriptSerializer json;
    readonly string html, mediaDir, gifDir, userDataDir, layoutFile;
    readonly bool devTools;
    readonly Rectangle initial;

    CoreWebView2Environment env;
    CoreWebView2Controller controller;
    /** The page has its first GIF on screen; until then the window stays hidden (no empty black box). */
    bool sceneReady;
    /** What the extension (or the X) last asked for. */
    bool wantVisible;
    bool shown;
    bool shownOnce;
    bool quitting;

    readonly System.Windows.Forms.Timer dragTimer = new System.Windows.Forms.Timer();
    bool dragging;
    string dragEdge = "";
    Native.POINT dragCursor;
    Rectangle dragBounds;

    /** How VS Code's windows are recognized: their process, or failing that its exe. */
    readonly uint codePid;
    readonly string codeExe;
    /** Hide while codeWindow is minimized. */
    bool minimizeWith;
    /** The VS Code window it follows, once known. */
    IntPtr codeWindow = IntPtr.Zero;
    bool codeMinimized;
    IntPtr minHook = IntPtr.Zero;
    /** Kept here: Windows calls it long after SetWinEventHook returns, so it must not be collected. */
    Native.WinEventProc minHookProc;

    public CatForm(string libDir, Dictionary<string, object> init, JavaScriptSerializer json)
    {
        this.libDir = libDir;
        this.json = json;
        html = Str(init, "html") ?? "";
        mediaDir = Str(init, "mediaDir") ?? "";
        gifDir = Str(init, "gifDir") ?? "";
        userDataDir = Str(init, "userDataDir") ?? "";
        layoutFile = Str(init, "layoutFile") ?? "";
        devTools = Flag(init, "devTools", false);
        codeExe = Str(init, "codeExe") ?? "";
        object pid;
        if (init.TryGetValue("codePid", out pid) && pid != null)
        {
            try
            {
                codePid = Convert.ToUInt32(pid);
            }
            catch
            {
                // the exe still identifies VS Code
            }
        }
        minimizeWith = Flag(init, "minimizeWith", true);

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Black;
        Text = "Cat Yoink";
        initial = InitialBounds();
        dragTimer.Interval = DRAG_TICK_MS;
        dragTimer.Tick += (s, e) => DragTick();
    }

    // ---- window style ----

    // Never steals focus when shown; a click still activates it (the minigame textarea takes typing).
    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            // Always on top without Form.TopMost (that activates the window when shown), and a tool
            // window: no taskbar button, not in Alt+Tab.
            cp.ExStyle |= Native.WS_EX_TOPMOST | Native.WS_EX_TOOLWINDOW;
            // Created where it will be shown, so it starts at that monitor's DPI.
            cp.X = initial.X;
            cp.Y = initial.Y;
            cp.Width = initial.Width;
            cp.Height = initial.Height;
            return cp;
        }
    }

    // ---- start ----

    public async void Start()
    {
        try
        {
            StartupGuess();
        }
        catch (Exception ex)
        {
            Log("finding the VS Code window failed: " + ex.Message); // the extension's claim may still find it
        }
        try
        {
            if (!UseLoader())
            {
                throw new Exception("no WebView2Loader.dll in " + libDir + " fits this process");
            }
            // Like the Electron window's backgroundThrottling: false, so GIF timing stays exact. No
            // component downloads (video DRM, ad-block lists...), which the page never uses: they
            // took most of the WebView2 folder.
            var options = new CoreWebView2EnvironmentOptions(
                "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows " +
                "--disable-component-update");
            env = await CoreWebView2Environment.CreateAsync(null, userDataDir, options);
            controller = await env.CreateCoreWebView2ControllerAsync(Handle);
            controller.DefaultBackgroundColor = Color.Black;
            controller.IsVisible = false; // follows the window (UpdateVisibility); WebView2 doesn't by itself
            FitController();

            CoreWebView2 wv = controller.CoreWebView2;
            CoreWebView2Settings st = wv.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.AreDevToolsEnabled = devTools;
            st.AreBrowserAcceleratorKeysEnabled = devTools; // no reload, print, find... (F12 with devTools)
            st.IsZoomControlEnabled = false;
            st.IsPinchZoomEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsSwipeNavigationEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            st.IsPasswordAutosaveEnabled = false;

            // The page comes from the extension (init.html, with its CSP and nonce filled in); what
            // it loads comes from media/ and the GIF folder. Allow: cross-origin loads (the font) pass CORS.
            Directory.CreateDirectory(gifDir);
            wv.SetVirtualHostNameToFolderMapping("cat-yoink.media", mediaDir, CoreWebView2HostResourceAccessKind.Allow);
            wv.SetVirtualHostNameToFolderMapping("cat-yoink.gifs", gifDir, CoreWebView2HostResourceAccessKind.Allow);
            wv.AddWebResourceRequestedFilter(PAGE + "*", CoreWebView2WebResourceContext.All);
            wv.WebResourceRequested += OnPageRequest;
            wv.NavigationStarting += (s, e) =>
            {
                if (!e.Uri.StartsWith(PAGE, StringComparison.Ordinal))
                {
                    e.Cancel = true;
                }
            };
            wv.NewWindowRequested += (s, e) => e.Handled = true;
            wv.WebMessageReceived += OnWebMessage;
            wv.ProcessFailed += OnProcessFailed;
            await LogPageErrors(wv);
            wv.Navigate(PAGE);
        }
        catch (Exception ex)
        {
            Fail(ex);
        }
    }

    /** Points the SDK at the WebView2Loader.dll built for this process (x64 or arm64). */
    bool UseLoader()
    {
        foreach (string arch in new[] { "win-x64", "win-arm64" })
        {
            string dir = Path.Combine(libDir, arch);
            // LoadLibrary fails for the other architecture (ERROR_BAD_EXE_FORMAT).
            if (File.Exists(Path.Combine(dir, "WebView2Loader.dll")) &&
                Native.LoadLibrary(Path.Combine(dir, "WebView2Loader.dll")) != IntPtr.Zero)
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(dir);
                return true;
            }
        }
        return false;
    }

    void Fail(Exception ex)
    {
        string text = ex is WebView2RuntimeNotFoundException
            ? "the Microsoft Edge WebView2 Runtime isn't installed"
            : ex.GetType().Name + ": " + ex.Message;
        CatHost.Emit("{\"t\":\"error\",\"text\":" + json.Serialize(text) + "}");
        CatHost.exitCode = 1;
        Quit();
    }

    void Log(string text)
    {
        CatHost.Emit("{\"t\":\"log\",\"text\":" + json.Serialize(text) + "}");
    }

    /** Page errors and warnings (exceptions, console.error, CSP and load failures) go to window.log. */
    async System.Threading.Tasks.Task LogPageErrors(CoreWebView2 wv)
    {
        wv.GetDevToolsProtocolEventReceiver("Runtime.exceptionThrown").DevToolsProtocolEventReceived += (s, e) =>
        {
            var p = Parse(e.ParameterObjectAsJson);
            var d = Dict(p, "exceptionDetails");
            var ex = Dict(d, "exception");
            Log("[page] " + (Str(ex, "description") ?? Str(d, "text") ?? "exception"));
        };
        wv.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled").DevToolsProtocolEventReceived += (s, e) =>
        {
            var p = Parse(e.ParameterObjectAsJson);
            string type = Str(p, "type");
            if (type != "error" && type != "warning")
            {
                return;
            }
            var text = new StringBuilder("[page] console." + type + ":");
            object args;
            if (p.TryGetValue("args", out args) && args is System.Collections.IEnumerable && !(args is string))
            {
                foreach (object a in (System.Collections.IEnumerable)args)
                {
                    var arg = a as Dictionary<string, object>;
                    object v = null;
                    if (arg != null && !arg.TryGetValue("value", out v))
                    {
                        arg.TryGetValue("description", out v);
                    }
                    text.Append(' ').Append(Convert.ToString(v));
                }
            }
            Log(text.ToString());
        };
        wv.GetDevToolsProtocolEventReceiver("Log.entryAdded").DevToolsProtocolEventReceived += (s, e) =>
        {
            var entry = Dict(Parse(e.ParameterObjectAsJson), "entry");
            string level = Str(entry, "level");
            if (level == "error" || level == "warning")
            {
                Log("[page] " + Str(entry, "source") + " " + level + ": " + Str(entry, "text") + " " + (Str(entry, "url") ?? ""));
            }
        };
        await wv.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
        await wv.CallDevToolsProtocolMethodAsync("Log.enable", "{}");
    }

    Dictionary<string, object> Parse(string text)
    {
        try
        {
            return json.Deserialize<Dictionary<string, object>>(text) ?? new Dictionary<string, object>();
        }
        catch
        {
            return new Dictionary<string, object>();
        }
    }

    static Dictionary<string, object> Dict(Dictionary<string, object> d, string key)
    {
        object v;
        return d != null && d.TryGetValue(key, out v) && v is Dictionary<string, object>
            ? (Dictionary<string, object>)v
            : new Dictionary<string, object>();
    }

    void OnPageRequest(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        string uri = e.Request.Uri;
        if (uri == PAGE || uri.StartsWith(PAGE + "?", StringComparison.Ordinal) || uri.StartsWith(PAGE + "#", StringComparison.Ordinal))
        {
            e.Response = env.CreateWebResourceResponse(
                new MemoryStream(Encoding.UTF8.GetBytes(html)), 200, "OK",
                "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
        }
        else if (uri.StartsWith(PAGE + "favicon.ico", StringComparison.Ordinal))
        {
            e.Response = env.CreateWebResourceResponse(null, 204, "No Content", ""); // no icon, no error
        }
        else
        {
            e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
        }
    }

    void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log("WebView2 process failed: " + e.ProcessFailedKind);
        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            CatHost.exitCode = 2; // the extension starts a new window
            Quit();
        }
        else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                 e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
        {
            controller.CoreWebView2.Reload(); // the fresh page says ready; the extension replays its state
        }
    }

    // ---- messages ----

    void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!e.Source.StartsWith(PAGE, StringComparison.Ordinal))
        {
            return;
        }
        string raw = e.WebMessageAsJson;
        Dictionary<string, object> m;
        try
        {
            m = json.Deserialize<Dictionary<string, object>>(raw);
        }
        catch
        {
            return;
        }
        string type = m == null ? null : Str(m, "type");
        switch (type)
        {
            case null:
                break;
            case "sceneReady":
                if (!sceneReady)
                {
                    sceneReady = true;
                    UpdateVisibility();
                }
                break;
            case "dragStart":
                StartDrag(Str(m, "edge"));
                break;
            case "dragEnd":
                EndDrag();
                break;
            case "close":
                UserClose();
                break;
            default:
                CatHost.Emit("{\"t\":\"page\",\"msg\":" + raw + "}");
                break;
        }
    }

    public void OnCommand(string line)
    {
        Dictionary<string, object> c;
        try
        {
            c = json.Deserialize<Dictionary<string, object>>(line);
        }
        catch
        {
            return;
        }
        switch (c == null ? null : Str(c, "cmd"))
        {
            case "show":
                wantVisible = true;
                UpdateVisibility();
                if (shown)
                {
                    BringToTop();
                }
                break;
            case "hide":
                wantVisible = false;
                UpdateVisibility();
                break;
            case "post":
                string msg = Str(c, "json");
                if (msg != null && controller != null)
                {
                    try
                    {
                        controller.CoreWebView2.PostWebMessageAsJson(msg);
                    }
                    catch (Exception ex)
                    {
                        Log("post failed: " + ex.Message);
                    }
                }
                break;
            case "claim":
                Claim();
                break;
            case "minimizeWith":
                minimizeWith = Flag(c, "on", true);
                UpdateVisibility();
                break;
            case "quit":
                Quit();
                break;
        }
    }

    static string Str(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) ? v as string : null;
    }

    static bool Flag(Dictionary<string, object> d, string key, bool fallback)
    {
        object v;
        return d.TryGetValue(key, out v) && v is bool ? (bool)v : fallback;
    }

    // ---- visibility ----

    void UpdateVisibility()
    {
        // Hidden along with VS Code: no "closed", so it comes back when VS Code does.
        bool withCode = minimizeWith && codeMinimized && codeWindow != IntPtr.Zero && Native.IsWindow(codeWindow);
        bool want = wantVisible && sceneReady && controller != null && !quitting && !withCode;
        if (want && !shown)
        {
            shown = true;
            ClampToScreen(); // the screens may have changed while it was hidden
            Native.ShowWindow(Handle, Native.SW_SHOWNOACTIVATE);
            controller.IsVisible = true;
            BringToTop();
            if (!shownOnce)
            {
                shownOnce = true;
                Log("first shown after " + CatHost.SinceStart() + " ms");
            }
        }
        else if (!want && shown)
        {
            EndDrag();
            SaveLayout();
            shown = false;
            controller.IsVisible = false;
            Native.ShowWindow(Handle, Native.SW_HIDE);
        }
    }

    void BringToTop()
    {
        Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
            Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
    }

    // ---- following the VS Code window (its minimize) ----

    /** At start: if exactly one VS Code window is open, it is ours. */
    void StartupGuess()
    {
        IntPtr only = IntPtr.Zero;
        int count = 0;
        Native.EnumWindows((h, l) =>
        {
            if (IsCodeWindow(h) && !Native.IsCloaked(h))
            {
                only = h;
                count++;
            }
            return true;
        }, IntPtr.Zero);
        if (count == 1)
        {
            Follow(only);
        }
    }

    /**
     * The extension says its VS Code window has focus: that is the foreground window. Only while
     * none is followed yet, so focusing one of VS Code's floating editor windows later changes nothing.
     */
    void Claim()
    {
        if (codeWindow != IntPtr.Zero && Native.IsWindow(codeWindow))
        {
            return;
        }
        IntPtr fg = Native.GetForegroundWindow();
        IntPtr root = fg == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(fg, Native.GA_ROOT);
        if (root != IntPtr.Zero)
        {
            fg = root;
        }
        if (IsCodeWindow(fg))
        {
            Follow(fg);
        }
    }

    /** A visible, unowned, top-level window of this VS Code (its main process, or failing that its exe). */
    bool IsCodeWindow(IntPtr h)
    {
        if (h == IntPtr.Zero || h == Handle || !Native.IsWindow(h) || !Native.IsWindowVisible(h))
        {
            return false;
        }
        if (Native.GetAncestor(h, Native.GA_ROOT) != h || Native.GetWindow(h, Native.GW_OWNER) != IntPtr.Zero)
        {
            return false;
        }
        // Workbench windows have a caption style and a title; Chromium's popups and overlays
        // (tooltips, drag images...) are untitled, no-activate or tool windows.
        if ((Native.GetWindowLong(h, Native.GWL_EXSTYLE) & (Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE)) != 0 ||
            (Native.GetWindowLong(h, Native.GWL_STYLE) & Native.WS_CAPTION) != Native.WS_CAPTION ||
            Native.GetWindowTextLength(h) == 0)
        {
            return false;
        }
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        if (codePid != 0 && pid == codePid)
        {
            return true;
        }
        return codeExe.Length > 0 && string.Equals(Native.ExePath(pid), codeExe, StringComparison.OrdinalIgnoreCase);
    }

    /** Follows `h`: Windows reports when it is minimized and restored. */
    void Follow(IntPtr h)
    {
        Unfollow();
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        if (minHookProc == null)
        {
            minHookProc = OnMinimizeEvent;
        }
        // Out of context: delivered through this thread's message loop.
        minHook = Native.SetWinEventHook(Native.EVENT_SYSTEM_MINIMIZESTART, Native.EVENT_SYSTEM_MINIMIZEEND,
            IntPtr.Zero, minHookProc, pid, 0, Native.WINEVENT_OUTOFCONTEXT);
        if (minHook == IntPtr.Zero)
        {
            Log("can't follow the VS Code window: SetWinEventHook failed");
            return; // never hidden for a minimize it can't see end
        }
        codeWindow = h;
        codeMinimized = Native.IsIconic(h);
        Log("following VS Code window " + h.ToInt64() + (codeMinimized ? " (minimized)" : ""));
        UpdateVisibility();
    }

    void Unfollow()
    {
        if (minHook != IntPtr.Zero)
        {
            Native.UnhookWinEvent(minHook);
            minHook = IntPtr.Zero;
        }
        codeWindow = IntPtr.Zero;
        codeMinimized = false;
    }

    void OnMinimizeEvent(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (hook != minHook || hwnd != codeWindow || idObject != Native.OBJID_WINDOW)
        {
            return;
        }
        // From the event, not IsIconic: at MINIMIZESTART the window may not be minimized yet.
        codeMinimized = evt == Native.EVENT_SYSTEM_MINIMIZESTART;
        UpdateVisibility();
    }

    /** The X or Alt+F4: hidden until the extension shows it again (the next cat). */
    void UserClose()
    {
        wantVisible = false;
        UpdateVisibility();
        CatHost.Emit("{\"t\":\"closed\"}");
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            UserClose();
            return;
        }
        base.OnFormClosing(e);
    }

    public void Quit()
    {
        if (quitting)
        {
            return;
        }
        quitting = true;
        EndDrag();
        SaveLayout();
        Unfollow();
        try
        {
            if (controller != null)
            {
                controller.Close();
            }
        }
        catch
        {
            // going away anyway
        }
        Application.ExitThread();
    }

    // ---- size and DPI ----

    void FitController()
    {
        if (controller == null)
        {
            return;
        }
        Native.RECT r;
        Native.GetClientRect(Handle, out r);
        controller.Bounds = new Rectangle(0, 0, r.Right - r.Left, r.Bottom - r.Top);
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case Native.WM_DPICHANGED:
                // Moved onto a monitor with another scale: take the size Windows suggests (same DIPs),
                // still fully on screen (growing on a higher-scale monitor can push it past an edge).
                var r = (Native.RECT)Marshal.PtrToStructure(m.LParam, typeof(Native.RECT));
                Rectangle s = OnScreen(Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom));
                Native.SetWindowPos(Handle, IntPtr.Zero, s.X, s.Y, s.Width, s.Height,
                    Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
                if (dragging)
                {
                    Native.GetCursorPos(out dragCursor); // carry on from here at the new size
                    dragBounds = WindowBounds();
                }
                else
                {
                    SaveLayout();
                }
                m.Result = IntPtr.Zero;
                return;
            case Native.WM_SIZE:
                base.WndProc(ref m);
                FitController();
                return;
            case Native.WM_MOVE:
                base.WndProc(ref m);
                if (controller != null)
                {
                    controller.NotifyParentWindowPositionChanged();
                }
                return;
            case Native.WM_DISPLAYCHANGE:
                // A monitor was unplugged or its resolution changed: back fully onto a screen.
                base.WndProc(ref m);
                if (!dragging)
                {
                    ClampToScreen();
                }
                return;
        }
        base.WndProc(ref m);
    }

    Rectangle WindowBounds()
    {
        Native.RECT r;
        Native.GetWindowRect(Handle, out r);
        return new Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    static int Scale(int dip, int dpi)
    {
        return (int)Math.Round(dip * dpi / 96.0);
    }

    int MinSize()
    {
        return Scale(MIN_SIZE, Native.DpiForWindow(Handle));
    }

    // ---- staying on screen: always fully on one monitor (it may cover the taskbar) ----

    /** `b` moved (and shrunk, if it is bigger) to lie fully on the monitor under its center. */
    static Rectangle OnScreen(Rectangle b)
    {
        return ClampInto(b, Native.MonitorBoundsAt(Center(b)));
    }

    static Rectangle ClampInto(Rectangle b, Rectangle area)
    {
        int w = Math.Min(b.Width, area.Width), h = Math.Min(b.Height, area.Height);
        int x = Math.Max(area.X, Math.Min(b.X, area.Right - w));
        int y = Math.Max(area.Y, Math.Min(b.Y, area.Bottom - h));
        return new Rectangle(x, y, w, h);
    }

    static Point Center(Rectangle b)
    {
        return new Point(b.X + b.Width / 2, b.Y + b.Height / 2);
    }

    /** Moves it back fully onto a screen if it isn't (screens changed, or an old saved layout). */
    void ClampToScreen()
    {
        Rectangle b = WindowBounds();
        Rectangle c = OnScreen(b);
        if (c != b)
        {
            Native.SetWindowPos(Handle, IntPtr.Zero, c.X, c.Y, c.Width, c.Height, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
            SaveLayout();
        }
    }

    // ---- saved layout: <storage>/window-layout.json, physical pixels ----

    Rectangle InitialBounds()
    {
        Rectangle saved;
        if (LoadLayout(out saved))
        {
            return OnScreen(saved); // saved before it kept to the screen, or the screens changed since
        }
        // The first time: bottom-right of the main screen, 24px in.
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        int dpi = Native.DpiAt(new Point(area.Right - 1, area.Bottom - 1));
        int w = Scale(DEFAULT_W, dpi), h = Scale(DEFAULT_H, dpi), inset = Scale(INSET, dpi);
        return new Rectangle(area.Right - w - inset, area.Bottom - h - inset, w, h);
    }

    /** The saved bounds, if they still overlap a connected screen. */
    bool LoadLayout(out Rectangle b)
    {
        b = Rectangle.Empty;
        try
        {
            var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(layoutFile));
            int x = Convert.ToInt32(d["x"]), y = Convert.ToInt32(d["y"]);
            int w = Convert.ToInt32(d["width"]), h = Convert.ToInt32(d["height"]);
            int min = Scale(MIN_SIZE, Native.DpiAt(new Point(x + w / 2, y + h / 2)));
            b = new Rectangle(x, y, Math.Max(min, w), Math.Max(min, h));
        }
        catch
        {
            return false; // nothing saved yet
        }
        foreach (Screen s in Screen.AllScreens)
        {
            Rectangle a = s.WorkingArea;
            if (b.X < a.Right - 40 && b.Right > a.X + 40 && b.Y < a.Bottom - 40 && b.Bottom > a.Y)
            {
                return true;
            }
        }
        return false;
    }

    void SaveLayout()
    {
        if (layoutFile.Length == 0 || !IsHandleCreated)
        {
            return;
        }
        Rectangle b = WindowBounds();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(layoutFile));
            File.WriteAllText(layoutFile,
                "{\"x\":" + b.X + ",\"y\":" + b.Y + ",\"width\":" + b.Width + ",\"height\":" + b.Height + "}");
        }
        catch
        {
            // best effort
        }
    }

    // ---- dragging and resizing ----
    //
    // The page says when a press on the picture (or an edge) starts and ends; we follow the cursor.
    // Not Windows' own move loop: holding the cat against a screen edge made it bounce, and Aero
    // Shake then minimized every other window.

    void StartDrag(string edge)
    {
        EndDrag();
        if (!shown)
        {
            return;
        }
        string e = edge ?? "";
        foreach (char ch in e)
        {
            if ("nsew".IndexOf(ch) < 0)
            {
                return;
            }
        }
        dragEdge = e;
        Native.GetCursorPos(out dragCursor);
        dragBounds = WindowBounds();
        dragging = true;
        dragTimer.Start();
    }

    void DragTick()
    {
        if (!dragging)
        {
            dragTimer.Stop();
            return;
        }
        if (!Native.PrimaryButtonDown())
        {
            EndDrag(); // the release went missing (e.g. it happened outside the window)
            return;
        }
        Native.POINT p;
        Native.GetCursorPos(out p);
        int dx = p.X - dragCursor.X, dy = p.Y - dragCursor.Y;
        Rectangle b = dragBounds;
        int x = b.X, y = b.Y, w = b.Width, h = b.Height;
        if (dragEdge.Length == 0)
        {
            // From where the drag started, not from the clamped spot: so its center can cross onto
            // the next monitor (it hops over), and it waits at an edge until the cursor comes back.
            Rectangle moved = OnScreen(new Rectangle(b.X + dx, b.Y + dy, b.Width, b.Height));
            x = moved.X;
            y = moved.Y;
            w = moved.Width;
            h = moved.Height;
        }
        else
        {
            // Edges stop at the monitor it is on; the minimum size wins over that.
            int min = MinSize();
            Rectangle area = Native.MonitorBoundsAt(Center(b));
            if (dragEdge.IndexOf('w') >= 0)
            {
                x = Math.Min(Math.Max(area.X, b.X + dx), b.Right - min);
                w = b.Right - x;
            }
            if (dragEdge.IndexOf('e') >= 0)
            {
                w = Math.Max(min, Math.Min(b.Width + dx, area.Right - b.X));
            }
            if (dragEdge.IndexOf('n') >= 0)
            {
                y = Math.Min(Math.Max(area.Y, b.Y + dy), b.Bottom - min);
                h = b.Bottom - y;
            }
            if (dragEdge.IndexOf('s') >= 0)
            {
                h = Math.Max(min, Math.Min(b.Height + dy, area.Bottom - b.Y));
            }
        }
        Rectangle cur = WindowBounds();
        if (cur.X != x || cur.Y != y || cur.Width != w || cur.Height != h)
        {
            Native.SetWindowPos(Handle, IntPtr.Zero, x, y, w, h, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
        }
    }

    void EndDrag()
    {
        if (!dragging)
        {
            return;
        }
        dragging = false;
        dragTimer.Stop();
        SaveLayout();
    }
}

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    public delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    public const int WS_CAPTION = 0x00C00000;
    public const int WS_EX_TOPMOST = 0x8;
    public const int WS_EX_TOOLWINDOW = 0x80;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
    public const uint GA_ROOT = 2, GW_OWNER = 4;
    public const int WM_MOVE = 0x0003;
    public const int WM_SIZE = 0x0005;
    public const int WM_DISPLAYCHANGE = 0x007E;
    public const int WM_DPICHANGED = 0x02E0;
    public const int SW_HIDE = 0;
    public const int SW_SHOWNOACTIVATE = 4;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
    public const uint EVENT_SYSTEM_MINIMIZESTART = 0x16, EVENT_SYSTEM_MINIMIZEEND = 0x17, WINEVENT_OUTOFCONTEXT = 0;
    public const int OBJID_WINDOW = 0;
    const int SM_SWAPBUTTON = 23;
    const int VK_LBUTTON = 1, VK_RBUTTON = 2;
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int DWMWA_CLOAKED = 14;

    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW")] public static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr LoadLibrary(string path);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    /** The full bounds of the monitor nearest `pt` (physical pixels), read fresh every time. */
    public static Rectangle MonitorBoundsAt(Point pt)
    {
        POINT p;
        p.X = pt.X;
        p.Y = pt.Y;
        var info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (GetMonitorInfo(MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST), ref info))
        {
            return Rectangle.FromLTRB(info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom);
        }
        return Screen.FromPoint(pt).Bounds;
    }

    /** Hidden by the shell (e.g. on another virtual desktop) though "visible". */
    public static bool IsCloaked(IntPtr hwnd)
    {
        int cloaked;
        return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
    }

    /** The exe of process `pid`, or "" if it can't be read. */
    public static string ExePath(uint pid)
    {
        IntPtr p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (p == IntPtr.Zero)
        {
            return "";
        }
        try
        {
            var sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            return QueryFullProcessImageNameW(p, 0, sb, ref size) ? sb.ToString() : "";
        }
        finally
        {
            CloseHandle(p);
        }
    }

    /** Physical pixels everywhere and crisp pixel art (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2). */
    public static void UsePerMonitorDpi()
    {
        try
        {
            // For the whole process where that is still open: CatHost.exe starts DPI-unaware.
            // powershell.exe has its setting already and refuses this; the thread's is set next.
            SetProcessDpiAwarenessContext(new IntPtr(-4));
        }
        catch (EntryPointNotFoundException)
        {
            // before Windows 10 1703
        }
        try
        {
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero)
            {
                return;
            }
        }
        catch (EntryPointNotFoundException)
        {
            // before Windows 10 1607
        }
        try
        {
            SetProcessDPIAware();
        }
        catch
        {
            // keep the default
        }
    }

    public static int DpiForWindow(IntPtr hwnd)
    {
        try
        {
            uint dpi = GetDpiForWindow(hwnd);
            return dpi > 0 ? (int)dpi : 96;
        }
        catch (EntryPointNotFoundException)
        {
            return 96;
        }
    }

    public static int DpiAt(Point pt)
    {
        try
        {
            POINT p;
            p.X = pt.X;
            p.Y = pt.Y;
            uint x, y;
            return GetDpiForMonitor(MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST), 0, out x, out y) == 0 && x > 0 ? (int)x : 96;
        }
        catch (Exception)
        {
            return 96; // no shcore.dll (before Windows 8.1)
        }
    }

    /** The logical left button (the right one when the buttons are swapped). */
    public static bool PrimaryButtonDown()
    {
        int vk = GetSystemMetrics(SM_SWAPBUTTON) != 0 ? VK_RBUTTON : VK_LBUTTON;
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }
}
