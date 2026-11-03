using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ISHIT.Desktop
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main()
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    public class MainForm : Form
    {
        private WebView2 _webView = null!;
        private NotifyIcon _trayIcon = null!;
        private bool _isCustomMaximized = false;
        private Rectangle _restoreBounds;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int WM_SYSCOMMAND = 0x0112;
        private const int WM_GETMINMAXINFO = 0x0024;
        private const int HTCAPTION = 2;
        private const int SC_SIZE = 0xF000;
        private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        private const int DWMWCP_ROUND = 2;
        private const int DWMWCP_DONOTROUND = 1;
        private const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MINMAXINFO
        {
            public POINT ptReserved;
            public POINT ptMaxSize;
            public POINT ptMaxPosition;
            public POINT ptMinTrackSize;
            public POINT ptMaxTrackSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        public MainForm()
        {
            Text = "ISHIT";
            Width = 1280;
            Height = 840;
            MinimumSize = new Size(960, 640);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Color.FromArgb(18, 18, 21);

            string icoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
            if (File.Exists(icoPath))
            {
                Icon = new Icon(icoPath);
            }

            ApplyWindowCornerPreference(DWMWCP_ROUND);
            _restoreBounds = new Rectangle(this.Left, this.Top, this.Width, this.Height);

            this.Resize += (_, _) =>
            {
                if (this.WindowState == FormWindowState.Maximized)
                {
                    // 若通过系统快捷键或任务栏触发原生 Maximized，自动转为工作区最大化以避免遮挡任务栏
                    this.WindowState = FormWindowState.Normal;
                    EnterWorkAreaMaximized();
                    return;
                }
                NotifyWebWindowState();
            };

            InitTray();
            InitWebView();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                const int WS_MINIMIZEBOX = 0x00020000;
                const int WS_MAXIMIZEBOX = 0x00010000;
                const int WS_THICKFRAME = 0x00040000;
                const int CS_DROPSHADOW = 0x00020000;
                var cp = base.CreateParams;
                cp.Style |= WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
                cp.ClassStyle |= CS_DROPSHADOW;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_NCCALCSIZE = 0x0083;
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_GETMINMAXINFO)
            {
                WmGetMinMaxInfo(m.LParam);
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }

        private void WmGetMinMaxInfo(IntPtr lParam)
        {
            try
            {
                MINMAXINFO mmi = (MINMAXINFO)Marshal.PtrToStructure(lParam, typeof(MINMAXINFO))!;
                IntPtr monitor = MonitorFromWindow(this.Handle, MONITOR_DEFAULTTONEAREST);
                if (monitor != IntPtr.Zero)
                {
                    MONITORINFO monitorInfo = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                    if (GetMonitorInfo(monitor, ref monitorInfo))
                    {
                        RECT rcWorkArea = monitorInfo.rcWork;
                        RECT rcMonitorArea = monitorInfo.rcMonitor;
                        mmi.ptMaxPosition.X = Math.Abs(rcWorkArea.Left - rcMonitorArea.Left);
                        mmi.ptMaxPosition.Y = Math.Abs(rcWorkArea.Top - rcMonitorArea.Top);
                        mmi.ptMaxSize.X = Math.Abs(rcWorkArea.Right - rcWorkArea.Left);
                        mmi.ptMaxSize.Y = Math.Abs(rcWorkArea.Bottom - rcWorkArea.Top);
                    }
                }
                mmi.ptMinTrackSize.X = this.MinimumSize.Width;
                mmi.ptMinTrackSize.Y = this.MinimumSize.Height;
                Marshal.StructureToPtr(mmi, lParam, true);
            }
            catch { }
        }

        private void ApplyWindowCornerPreference(int cornerPref)
        {
            try
            {
                DwmSetWindowAttribute(this.Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref cornerPref, sizeof(int));
            }
            catch { }
        }

        private void EnterWorkAreaMaximized()
        {
            if (!_isCustomMaximized)
            {
                _restoreBounds = this.Bounds;
            }
            Rectangle workArea = Screen.FromControl(this).WorkingArea;
            _isCustomMaximized = true;
            ApplyWindowCornerPreference(DWMWCP_DONOTROUND);
            this.Bounds = workArea;
            NotifyWebWindowState();
        }

        private void RestoreFromWorkAreaMaximized()
        {
            _isCustomMaximized = false;
            ApplyWindowCornerPreference(DWMWCP_ROUND);
            if (_restoreBounds.Width >= this.MinimumSize.Width && _restoreBounds.Height >= this.MinimumSize.Height)
            {
                this.Bounds = _restoreBounds;
            }
            else
            {
                Rectangle workArea = Screen.FromControl(this).WorkingArea;
                int w = Math.Min(1280, workArea.Width - 60);
                int h = Math.Min(840, workArea.Height - 60);
                this.Bounds = new Rectangle(
                    workArea.Left + (workArea.Width - w) / 2,
                    workArea.Top + (workArea.Height - h) / 2,
                    w,
                    h
                );
            }
            NotifyWebWindowState();
        }

        private void ToggleWorkAreaMaximized()
        {
            if (_isCustomMaximized)
            {
                RestoreFromWorkAreaMaximized();
            }
            else
            {
                EnterWorkAreaMaximized();
            }
        }

        private void NotifyWebWindowState()
        {
            try
            {
                if (_webView?.CoreWebView2 != null)
                {
                    bool isMax = _isCustomMaximized || this.WindowState == FormWindowState.Maximized;
                    _webView.CoreWebView2.ExecuteScriptAsync($"if(window.onHostWindowStateChange)window.onHostWindowStateChange({(isMax ? "true" : "false")});");
                }
            }
            catch { }
        }

        private void HandleWebWindowMessage(string msg)
        {
            if (string.IsNullOrWhiteSpace(msg)) return;
            string cmd = msg.Trim();
            if (cmd == "win:drag")
            {
                if (_isCustomMaximized)
                {
                    // 全屏/最大化状态下按住顶栏拖拽时，自动按鼠标比例还原窗口并继续跟手拖动
                    Point cursor = Cursor.Position;
                    Rectangle workArea = Screen.FromControl(this).WorkingArea;
                    double ratioX = Math.Max(0.1, Math.Min(0.9, (double)(cursor.X - workArea.Left) / Math.Max(1, workArea.Width)));
                    int restoreW = _restoreBounds.Width >= MinimumSize.Width ? _restoreBounds.Width : 1280;
                    int restoreH = _restoreBounds.Height >= MinimumSize.Height ? _restoreBounds.Height : 840;
                    _isCustomMaximized = false;
                    ApplyWindowCornerPreference(DWMWCP_ROUND);
                    this.Bounds = new Rectangle(
                        cursor.X - (int)(restoreW * ratioX),
                        Math.Max(workArea.Top, cursor.Y - 22),
                        restoreW,
                        restoreH
                    );
                    NotifyWebWindowState();
                }
                ReleaseCapture();
                SendMessage(this.Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                return;
            }
            if (cmd == "win:minimize")
            {
                this.WindowState = FormWindowState.Minimized;
                return;
            }
            if (cmd == "win:maximize")
            {
                ToggleWorkAreaMaximized();
                return;
            }
            if (cmd == "win:close")
            {
                this.Close();
                return;
            }
            if (cmd.StartsWith("win:resize:"))
            {
                if (_isCustomMaximized) return;
                string dir = cmd.Substring("win:resize:".Length);
                int wmsz = dir switch
                {
                    "left" => 1,
                    "right" => 2,
                    "top" => 3,
                    "topleft" => 4,
                    "topright" => 5,
                    "bottom" => 6,
                    "bottomleft" => 7,
                    "bottomright" => 8,
                    _ => 0
                };
                if (wmsz > 0)
                {
                    ReleaseCapture();
                    SendMessage(this.Handle, WM_SYSCOMMAND, (IntPtr)(SC_SIZE + wmsz), IntPtr.Zero);
                    _restoreBounds = this.Bounds;
                }
            }
        }

        private void InitTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开 ISHIT", null, (_, _) => ShowMainWindow());
            menu.Items.Add("重新加载界面与配置", null, (_, _) => _webView?.Reload());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("彻底退出", null, (_, _) =>
            {
                _trayIcon.Visible = false;
                Application.Exit();
            });

            _trayIcon = new NotifyIcon
            {
                Text = "ISHIT",
                Icon = this.Icon ?? SystemIcons.Application,
                ContextMenuStrip = menu,
                Visible = true
            };
            _trayIcon.DoubleClick += (_, _) => ShowMainWindow();
        }

        private void ShowMainWindow()
        {
            Show();
            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }
            Activate();
            NotifyWebWindowState();
        }

        private string LoadOrCreateRootConfigJson(string wwwPath)
        {
            const string defaultJson = "{\r\n  \"serverHost\": \"47.117.27.75\",\r\n  \"serverPort\": 80,\r\n  \"apiBaseUrl\": \"http://47.117.27.75\",\r\n  \"httpsApiBaseUrl\": \"https://appraisal-occurring-performance-phrase.trycloudflare.com\",\r\n  \"directIpUrl\": \"http://47.117.27.75\"\r\n}";
            string rootCfgPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");
            try
            {
                if (!File.Exists(rootCfgPath))
                {
                    File.WriteAllText(rootCfgPath, defaultJson, new UTF8Encoding(false));
                }
                string raw = File.ReadAllText(rootCfgPath, Encoding.UTF8).Trim();
                if (string.IsNullOrWhiteSpace(raw) || raw.Contains("api.ishit.pw") || raw.Contains(":8080"))
                {
                    raw = defaultJson;
                    File.WriteAllText(rootCfgPath, defaultJson, new UTF8Encoding(false));
                }
                if (Directory.Exists(wwwPath))
                {
                    string wwwCfgPath = Path.Combine(wwwPath, "config.json");
                    File.WriteAllText(wwwCfgPath, raw, new UTF8Encoding(false));
                }
                return raw;
            }
            catch
            {
                return defaultJson;
            }
        }

        private async void InitWebView()
        {
            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(243, 243, 245)
            };
            Controls.Add(_webView);

            try
            {
                string userDataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ISHIT_Desktop_Client",
                    "WebView2Data"
                );
                Directory.CreateDirectory(userDataDir);

                var opts = new CoreWebView2EnvironmentOptions("--disable-web-security --allow-running-insecure-content");
                var env = await CoreWebView2Environment.CreateAsync(null, userDataDir, opts);
                await _webView.EnsureCoreWebView2Async(env);

                var settings = _webView.CoreWebView2.Settings;
                settings.AreDefaultContextMenusEnabled = true;
                settings.AreDevToolsEnabled = true;
                settings.IsStatusBarEnabled = false;
                settings.IsZoomControlEnabled = true;

                _webView.CoreWebView2.WebMessageReceived += (_, args) =>
                {
                    try
                    {
                        string msg = args.TryGetWebMessageAsString();
                        if (!string.IsNullOrEmpty(msg))
                        {
                            if (this.InvokeRequired)
                            {
                                this.BeginInvoke(new Action(() => HandleWebWindowMessage(msg)));
                            }
                            else
                            {
                                HandleWebWindowMessage(msg);
                            }
                        }
                    }
                    catch { }
                };

                _webView.CoreWebView2.NavigationCompleted += (_, _) => NotifyWebWindowState();

                // 自动授予相机与定位权限（用于扫码签到和位置选点）
                _webView.CoreWebView2.PermissionRequested += (_, args) =>
                {
                    if (args.PermissionKind == CoreWebView2PermissionKind.Camera ||
                        args.PermissionKind == CoreWebView2PermissionKind.Geolocation ||
                        args.PermissionKind == CoreWebView2PermissionKind.ClipboardRead)
                    {
                        args.State = CoreWebView2PermissionState.Allow;
                    }
                };

                string wwwPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "www");
                if (!Directory.Exists(wwwPath))
                {
                    wwwPath = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..", "web"));
                }

                string configJsonRaw = LoadOrCreateRootConfigJson(wwwPath);

                // 注入独立客户端标识与外部 config.json 配置（禁止界面修改，仅由配置文件驱动）
                await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                    "window.ISHIT_NATIVE_CLIENT = true; window.ISHIT_PLATFORM = 'windows'; " +
                    "try { window.ISHIT_CONFIG = " + configJsonRaw + "; } catch(e) {}"
                );

                // 映射本地虚拟域名 https://ishit.local 以支持安全上下文（摄像头 getUserMedia、Clipboard、localStorage）
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "ishit.local",
                    wwwPath,
                    CoreWebView2HostResourceAccessKind.Allow
                );

                _webView.CoreWebView2.Navigate("https://ishit.local/index.html");
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "初始化 WebView2 运行时失败，请确认系统已安装 Microsoft Edge WebView2 Runtime。\n\n错误详情: " + ex.Message,
                    "ISHIT 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                _trayIcon.Dispose();
            }
            base.OnFormClosing(e);
        }
    }
}
