using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class HiddenStdioLauncher
{
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint DuplicateSameAccess = 0x00000002;
    private const uint Synchronize = 0x00100000;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitObject0 = 0;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int ProcessBasicInformation = 0;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformationData
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformationData
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref StartupInfo lpStartupInfo,
        out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr hSourceProcessHandle,
        IntPtr hSourceHandle,
        IntPtr hTargetProcessHandle,
        out IntPtr lpTargetHandle,
        uint dwDesiredAccess,
        bool bInheritHandle,
        uint dwOptions);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int jobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint nCount,
        IntPtr[] lpHandles,
        bool bWaitAll,
        uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref ProcessBasicInformationData processInformation,
        int processInformationLength,
        out int returnLength);

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return value;

        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\')
            {
                slashes++;
                continue;
            }

            if (ch == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }

            result.Append('\\', slashes);
            slashes = 0;
            result.Append(ch);
        }

        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static IntPtr DuplicateStandardHandle(int handleId)
    {
        var source = GetStdHandle(handleId);
        if (source == IntPtr.Zero || source == new IntPtr(-1))
            return source;

        IntPtr duplicate;
        var currentProcess = GetCurrentProcess();
        if (!DuplicateHandle(
                currentProcess,
                source,
                currentProcess,
                out duplicate,
                0,
                true,
                DuplicateSameAccess))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return duplicate;
    }

    private static IntPtr OpenParentProcess()
    {
        var info = new ProcessBasicInformationData();
        int returnLength;
        var status = NtQueryInformationProcess(
            GetCurrentProcess(),
            ProcessBasicInformation,
            ref info,
            Marshal.SizeOf(typeof(ProcessBasicInformationData)),
            out returnLength);
        if (status != 0 || info.InheritedFromUniqueProcessId == IntPtr.Zero)
            return IntPtr.Zero;
        return OpenProcess(Synchronize, false, unchecked((uint)info.InheritedFromUniqueProcessId.ToInt64()));
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            return IntPtr.Zero;

        var info = new JobObjectExtendedLimitInformationData();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformationData));
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, unchecked((uint)size)))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
        return job;
    }

    private static int Main(string[] args)
    {
        if (args.Length < 1)
            return 64;

        var commandLine = new StringBuilder(Quote(args[0]));
        for (var i = 1; i < args.Length; i++)
        {
            commandLine.Append(' ');
            commandLine.Append(Quote(args[i]));
        }

        var stdin = DuplicateStandardHandle(StdInputHandle);
        var stdout = DuplicateStandardHandle(StdOutputHandle);
        var stderr = DuplicateStandardHandle(StdErrorHandle);
        var parent = OpenParentProcess();
        var job = CreateKillOnCloseJob();
        var startup = new StartupInfo
        {
            cb = Marshal.SizeOf(typeof(StartupInfo)),
            dwFlags = StartfUseStdHandles,
            hStdInput = stdin,
            hStdOutput = stdout,
            hStdError = stderr
        };

        ProcessInformation process;
        try
        {
            if (!CreateProcess(
                    args[0],
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment,
                    IntPtr.Zero,
                    null,
                    ref startup,
                    out process))
            {
                return new Win32Exception(Marshal.GetLastWin32Error()).NativeErrorCode;
            }
        }
        finally
        {
            if (stdin != IntPtr.Zero && stdin != new IntPtr(-1)) CloseHandle(stdin);
            if (stdout != IntPtr.Zero && stdout != new IntPtr(-1)) CloseHandle(stdout);
            if (stderr != IntPtr.Zero && stderr != new IntPtr(-1)) CloseHandle(stderr);
        }

        try
        {
            if (job != IntPtr.Zero && !AssignProcessToJobObject(job, process.hProcess))
            {
                CloseHandle(job);
                job = IntPtr.Zero;
            }
            if (ResumeThread(process.hThread) == uint.MaxValue)
            {
                TerminateProcess(process.hProcess, 1);
                return 1;
            }

            if (parent != IntPtr.Zero)
            {
                var waitResult = WaitForMultipleObjects(
                    2,
                    new[] { process.hProcess, parent },
                    false,
                    Infinite);
                if (waitResult == WaitObject0 + 1)
                {
                    if (job != IntPtr.Zero)
                    {
                        CloseHandle(job);
                        job = IntPtr.Zero;
                    }
                    else
                    {
                        TerminateProcess(process.hProcess, 143);
                    }
                    WaitForSingleObject(process.hProcess, 5000);
                    return 143;
                }
            }
            else
            {
                WaitForSingleObject(process.hProcess, Infinite);
            }

            uint exitCode;
            return GetExitCodeProcess(process.hProcess, out exitCode) ? unchecked((int)exitCode) : 1;
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (parent != IntPtr.Zero) CloseHandle(parent);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }
}
