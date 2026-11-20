using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace ISHIT.Desktop
{
    internal sealed class LocalTransport : IDisposable
    {
        private readonly HttpClient client = new HttpClient(new HttpClientHandler
        {
            AllowAutoRedirect = false, UseCookies = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        });
        private readonly ConcurrentDictionary<string, CancellationTokenSource> pending = new ConcurrentDictionary<string, CancellationTokenSource>();
        private volatile bool foreground = true;
        public void SetForeground(bool active) { foreground = active; if (!active) CancelAll(); }
        private JavaScriptSerializer Json() => new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public void Cancel(string id)
        {
            if (pending.TryGetValue(id, out var token)) token.Cancel();
        }

        public void CancelAll()
        {
            foreach (var token in pending.Values) token.Cancel();
        }

        public async Task<string> SendAsync(string raw)
        {
            var data = Json().Deserialize<Dictionary<string, object>>(raw);
            string id = Convert.ToString(data["id"]);
            var result = new Dictionary<string, object> { ["id"] = id };
            var token = new CancellationTokenSource();
            pending[id] = token;
            try
            {
                if (!foreground) throw new Exception("请保持客户端在前台");
                var url = new Uri(Convert.ToString(data["url"]));
                if (url.Scheme != "https" && url.Scheme != "http") throw new Exception("仅支持 HTTP 和 HTTPS 请求");
                token.CancelAfter(Convert.ToInt32(data["timeout"]) + 1000);
                using (var request = new HttpRequestMessage(new HttpMethod(Convert.ToString(data["method"])), url))
                {
                    var body = Convert.FromBase64String(Convert.ToString(data["body"]));
                    if (body.Length > 0) request.Content = new ByteArrayContent(body);
                    foreach (var pair in (Dictionary<string, object>)data["headers"])
                    {
                        if (pair.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                        if (!request.Headers.TryAddWithoutValidation(pair.Key, Convert.ToString(pair.Value)) && request.Content != null)
                            request.Content.Headers.TryAddWithoutValidation(pair.Key, Convert.ToString(pair.Value));
                    }
                    using (var response = await client.SendAsync(request, token.Token))
                    {
                        var headers = new Dictionary<string, object>();
                        foreach (var pair in response.Headers) headers[pair.Key.ToLowerInvariant()] = pair.Key.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase) ? (object)new List<string>(pair.Value) : string.Join(", ", pair.Value);
                        foreach (var pair in response.Content.Headers) headers[pair.Key.ToLowerInvariant()] = string.Join(", ", pair.Value);
                        result["status"] = (int)response.StatusCode;
                        result["headers"] = headers;
                        result["body"] = Convert.ToBase64String(await response.Content.ReadAsByteArrayAsync());
                    }
                }
            }
            catch (Exception error) { result["error"] = error.Message; }
            finally { pending.TryRemove(id, out _); token.Dispose(); }
            return Json().Serialize(result);
        }

        public void Dispose() { CancelAll(); client.Dispose(); }
    }
}
