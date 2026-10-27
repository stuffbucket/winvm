// Start a program on the interactive desktop of the active console session,
// from session 0 (qemu-ga runs as SYSTEM there, where nothing it starts can
// show a window). Compiled in the guest by agent-install.ps1 via Add-Type.
//
//   runinsession.exe [--wait] [--hidden] [--self] <exe> [args...]
//
//   --wait    wait for it and exit with its exit code
//   --hidden  no console window (CREATE_NO_WINDOW) instead of a new visible one
//   --self    as THIS process's user, in its session, with its environment and
//             working directory: the agent's launcher (it already runs on the
//             desktop; only SYSTEM may call WTSQueryUserToken).
//
// WHY THE AGENT NEEDS THIS AT ALL. A program the agent starts must outlive the
// agent, so it cannot be an ordinary libuv child (those sit in a kill-on-close
// job). Node/Bun's `detached` is the only other way, and that is
// DETACHED_PROCESS: no console. Windows PowerShell started like that exits 0 at
// once without running anything, and `conhost --headless` does too. Started
// from here instead, a console program gets a console of its own (hidden with
// --hidden), and this process's job lets its children break away silently.
//
// Prints "session <id> pid <pid>". Exit 2-4: no user token / no logon / spawn failed.
using System;
using System.Runtime.InteropServices;
using System.Text;

class RunInSession {
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint s, out IntPtr t);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr h, uint acc, IntPtr sa, int imp, int type, out IntPtr n);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr tok, bool inherit);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SI { public int cb; public string r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr tok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint s);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint c);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    // MSVCRT quoting, which is what a program's argv parser undoes.
    static string Q(string a) {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a) {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1); bs = 0; sb.Append('"'); continue; }
            sb.Append('\\', bs); bs = 0; sb.Append(c);
        }
        sb.Append('\\', bs * 2).Append('"');
        return sb.ToString();
    }

    static int Main(string[] argv) {
        int i = 0; bool wait = false, hidden = false, self = false;
        for (; i < argv.Length; i++) {
            if (argv[i] == "--wait") wait = true;
            else if (argv[i] == "--hidden") hidden = true;
            else if (argv[i] == "--self") self = true;
            else break;
        }
        if (i >= argv.Length) { Console.Error.WriteLine("usage: runinsession [--wait] [--hidden] [--self] <exe> [args...]"); return 1; }
        var cmd = new StringBuilder();
        for (int k = i; k < argv.Length; k++) { if (k > i) cmd.Append(' '); cmd.Append(Q(argv[k])); }
        var si = new SI(); si.cb = Marshal.SizeOf(si);
        PI pi;
        uint window = hidden ? 0x08000000u /* CREATE_NO_WINDOW */ : 0x00000010u /* CREATE_NEW_CONSOLE */;
        uint sid;
        if (self) {
            // Handles NOT inherited: nothing of this process's (its stdout pipe
            // to the agent) may outlive it in the program.
            if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, window, IntPtr.Zero, null, ref si, out pi)) {
                Console.Error.WriteLine("CreateProcess " + Marshal.GetLastWin32Error()); return 4;
            }
            ProcessIdToSessionId(GetCurrentProcessId(), out sid);
        } else {
            sid = WTSGetActiveConsoleSessionId();
            IntPtr ut, pt, env;
            if (!WTSQueryUserToken(sid, out ut)) { Console.Error.WriteLine("WTSQueryUserToken " + Marshal.GetLastWin32Error()); return 2; }
            if (!DuplicateTokenEx(ut, 0x02000000, IntPtr.Zero, 2, 1, out pt)) { Console.Error.WriteLine("DuplicateTokenEx " + Marshal.GetLastWin32Error()); return 3; }
            CreateEnvironmentBlock(out env, pt, false);
            si.desk = "winsta0\\default";
            uint flags = 0x00000400 /* UNICODE_ENVIRONMENT */ | window;
            if (!CreateProcessAsUser(pt, null, cmd, IntPtr.Zero, IntPtr.Zero, false, flags, env, null, ref si, out pi)) {
                Console.Error.WriteLine("CreateProcessAsUser " + Marshal.GetLastWin32Error()); return 4;
            }
            CloseHandle(ut); CloseHandle(pt);
        }
        Console.WriteLine("session " + sid + " pid " + pi.pid);
        int code = 0;
        if (wait) { WaitForSingleObject(pi.hp, 0xFFFFFFFF); uint c; GetExitCodeProcess(pi.hp, out c); code = (int)c; }
        CloseHandle(pi.ht); CloseHandle(pi.hp);
        return code;
    }
}
