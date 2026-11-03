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

        public MainForm()
        {
            Text = "ISHIT";
            Width = 1280;
            Height = 840;
            MinimumSize = new Size(960, 640);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(243, 243, 245);

            string icoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
            if (File.Exists(icoPath))
            {
                Icon = new Icon(icoPath);
            }

            InitTray();
            InitWebView();
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
        }

        private string LoadOrCreateRootConfigJson(string wwwPath)
        {
            const string defaultJson = "{\r\n  \"serverHost\": \"47.117.27.75\",\r\n  \"serverPort\": 80,\r\n  \"apiBaseUrl\": \"http://47.117.27.75\",\r\n  \"directIpUrl\": \"http://47.117.27.75\"\r\n}";
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
