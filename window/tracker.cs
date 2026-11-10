// Win32 helper for the Cat Yoink window (window/main.js): finds the VS Code window that started
// us, reports its frame and minimized state, and keeps the cat window stacked directly above it.
// Loaded with `Add-Type -Path` by powershell.exe, so it must stay C# 5 (no $"", ?., out var).
//
// stdin, one command per line:
//   cat <hwnd>   the cat window's own handle
//   hint <hwnd>  track this window if it is a VS Code window (after a hot reload)
//   startup      track the only visible VS Code window, if there is exactly one
//   claim        track the foreground window if it is a VS Code window and nothing is tracked yet
//   reclaim      same, but replaces the tracked window
// stdout, JSON lines, only on change:
//   {"t":"owner","hwnd":N}  {"t":"rect","x":..,"y":..,"w":..,"h":..}  {"t":"min","v":bool}  {"t":"gone"}
// Rects are physical screen pixels. The process exits when stdin closes.
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CatTracker
{
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    const uint GA_ROOT = 2;
    const uint GW_HWNDPREV = 3;
    const uint GW_OWNER = 4;
    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const int WS_CAPTION = 0x00C00000;
    const int WS_EX_TOPMOST = 0x8;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int TICK_MS = 16;

    static readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
    static volatile bool inputClosed;

    static uint codePid;
    static string codeExe = "";
    static IntPtr cat = IntPtr.Zero;
    static IntPtr target = IntPtr.Zero;
    static string lastRect;
    static int lastMin = -1;

    public static void Run()
    {
        // Physical pixels everywhere (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).
        try
        {
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
            {
                SetProcessDPIAware();
            }
        }
        catch (EntryPointNotFoundException)
        {
            SetProcessDPIAware();
        }

        uint.TryParse(Environment.GetEnvironmentVariable("CAT_YOINK_CODE_PID"), out codePid);
        codeExe = Environment.GetEnvironmentVariable("CAT_YOINK_CODE_EXE") ?? "";

        var reader = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    inbox.Enqueue(line);
                }
            }
            catch
            {
                // stdin broke: same as closed
            }
            inputClosed = true;
        });
        reader.IsBackground = true;
        reader.Start();

        while (!inputClosed)
        {
            string cmd;
            while (inbox.TryDequeue(out cmd))
            {
                Handle(cmd.Trim());
            }
            Tick();
            Thread.Sleep(TICK_MS);
        }
    }

    static void Handle(string line)
    {
        string[] parts = line.Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
        {
            return;
        }
        switch (parts[0])
        {
            case "cat":
                cat = ParseHwnd(parts);
                break;
            case "hint":
                IntPtr h = ParseHwnd(parts);
                if (h != target && IsCandidate(h))
                {
                    Adopt(h);
                }
                break;
            case "startup":
                if (target == IntPtr.Zero)
                {
                    StartupGuess();
                }
                break;
            case "claim":
                if (target == IntPtr.Zero)
                {
                    ClaimForeground();
                }
                break;
            case "reclaim":
                ClaimForeground();
                break;
        }
    }

    static IntPtr ParseHwnd(string[] parts)
    {
        long v;
        return parts.Length > 1 && long.TryParse(parts[1].Trim(), out v) ? new IntPtr(v) : IntPtr.Zero;
    }

    static void ClaimForeground()
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero)
        {
            return;
        }
        IntPtr root = GetAncestor(fg, GA_ROOT);
        if (root != IntPtr.Zero)
        {
            fg = root;
        }
        if (fg != target && IsCandidate(fg))
        {
            Adopt(fg);
        }
    }

    static void StartupGuess()
    {
        IntPtr only = IntPtr.Zero;
        int count = 0;
        EnumWindows((h, l) =>
        {
            if (IsCandidate(h) && !IsCloaked(h))
            {
                only = h;
                count++;
            }
            return true;
        }, IntPtr.Zero);
        if (count == 1)
        {
            Adopt(only);
        }
    }

    /** A visible, unowned, top-level window of this VS Code (its main process, or failing that its exe). */
    static bool IsCandidate(IntPtr h)
    {
        if (h == IntPtr.Zero || h == cat || !IsWindow(h) || !IsWindowVisible(h))
        {
            return false;
        }
        if (GetAncestor(h, GA_ROOT) != h || GetWindow(h, GW_OWNER) != IntPtr.Zero)
        {
            return false;
        }
        // Workbench windows have a caption style and a title; Chromium's popups and overlays
        // (tooltips, drag images...) are untitled, no-activate or tool windows.
        if ((GetWindowLong(h, GWL_EXSTYLE) & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) != 0 ||
            (GetWindowLong(h, GWL_STYLE) & WS_CAPTION) != WS_CAPTION ||
            GetWindowTextLengthW(h) == 0)
        {
            return false;
        }
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (codePid != 0 && pid == codePid)
        {
            return true;
        }
        return codeExe.Length > 0 && string.Equals(ExePath(pid), codeExe, StringComparison.OrdinalIgnoreCase);
    }

    static string ExePath(uint pid)
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

    static bool IsCloaked(IntPtr h)
    {
        int cloaked;
        return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
    }

    static bool IsTopmost(IntPtr h)
    {
        return (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    }

    static void Adopt(IntPtr h)
    {
        target = h;
        lastRect = null;
        lastMin = -1;
        Emit("{\"t\":\"owner\",\"hwnd\":" + h.ToInt64() + "}");
    }

    static void Tick()
    {
        if (target == IntPtr.Zero)
        {
            return;
        }
        if (!IsWindow(target))
        {
            target = IntPtr.Zero;
            Emit("{\"t\":\"gone\"}");
            return;
        }
        bool min = IsIconic(target);
        if (!min)
        {
            FixZOrder(); // before reporting the rect, so the cat is never shown out of place
            RECT r;
            if (DwmGetWindowAttribute(target, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
            {
                GetWindowRect(target, out r);
            }
            string rect = "{\"t\":\"rect\",\"x\":" + r.Left + ",\"y\":" + r.Top +
                ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) + "}";
            if (rect != lastRect)
            {
                lastRect = rect;
                Emit(rect);
            }
        }
        int m = min ? 1 : 0;
        if (m != lastMin)
        {
            lastMin = m;
            Emit("{\"t\":\"min\",\"v\":" + (min ? "true" : "false") + "}");
        }
    }

    /**
     * Keeps the cat directly above VS Code: below anything that covers VS Code, above VS Code
     * itself. Also done while the cat is hidden, so it appears in the right place. Skips
     * invisible windows and VS Code's own popups when checking.
     */
    static void FixZOrder()
    {
        if (cat == IntPtr.Zero || !IsWindow(cat))
        {
            return;
        }
        IntPtr above = GetWindow(target, GW_HWNDPREV);
        for (IntPtr p = above; p != IntPtr.Zero; p = GetWindow(p, GW_HWNDPREV))
        {
            if (p == cat)
            {
                return;
            }
            if (IsTopmost(p) || (IsWindowVisible(p) && GetWindow(p, GW_OWNER) != target))
            {
                break;
            }
        }
        // SetWindowPos puts the cat just below `after`. Directly below a topmost window would make
        // the cat topmost too; VS Code is then the top normal window, so HWND_TOP is right.
        IntPtr after = above == IntPtr.Zero || IsTopmost(above) ? IntPtr.Zero : above;
        SetWindowPos(cat, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }

    static void Emit(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }
}
