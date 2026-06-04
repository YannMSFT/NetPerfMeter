(function () {
  'use strict';

  var PING_COUNT = 25;
  var PING_INTERVAL_MS = 100;
  var PING_TIMEOUT_MS = 2000;
  var DOWNLOAD_MS = 9000;
  var UPLOAD_MS = 9000;
  var WARMUP_MS = 1000;
  var PARALLEL_STREAMS = 4;
  var DOWNLOAD_BYTES = 50 * 1024 * 1024;
  var UPLOAD_BYTES = 4 * 1024 * 1024;
  var RING_CIRCUMFERENCE = 113;
  var SCORE_CIRCUMFERENCE = 2 * Math.PI * 52;

  // Weights and 0–100 mapping anchors for the combined Network Quality Score.
  var SCORE_WEIGHTS = { download: 0.30, upload: 0.20, latency: 0.25, jitter: 0.10, loss: 0.15 };
  var SCORE_ANCHORS = {
    download: [[0, 0], [5, 40], [25, 70], [100, 90], [300, 100]],
    upload: [[0, 0], [2, 40], [10, 70], [50, 90], [150, 100]],
    latency: [[10, 100], [30, 90], [60, 70], [100, 45], [150, 20], [300, 0]],
    jitter: [[1, 100], [5, 90], [15, 65], [30, 35], [60, 0]],
    loss: [[0, 100], [0.5, 90], [1, 75], [3, 45], [5, 20], [10, 0]]
  };
  var SCORE_TIERS = [
    { min: 90, grade: 'A+', labelKey: 'tier.excellent', color: '#5ee6a8' },
    { min: 80, grade: 'A', labelKey: 'tier.excellent', color: '#5ee6a8' },
    { min: 70, grade: 'B', labelKey: 'tier.good', color: '#8be08a' },
    { min: 55, grade: 'C', labelKey: 'tier.fair', color: '#ffd166' },
    { min: 40, grade: 'D', labelKey: 'tier.poor', color: '#ff9f6e' },
    { min: 0, grade: 'F', labelKey: 'tier.veryPoor', color: '#ff6b8a' }
  ];

  // ---- Internationalization (auto-detects French browsers) ----
  var I18N = {
    en: {
      'hero.eyebrow': 'LAN speed test',
      'hero.title': 'WiFi Performance Meter',
      'hero.subtitle': 'Measure latency, jitter, packet loss, download and upload throughput against this same-origin server.',
      'btn.start': 'Start test',
      'btn.stop': 'Stop',
      'metric.latency': 'Latency',
      'metric.latency.unit': 'avg',
      'metric.jitter': 'Jitter',
      'metric.jitter.unit': 'mean Δ',
      'metric.jitter.sub': 'lower is smoother',
      'metric.loss': 'Packet loss',
      'metric.loss.unit': 'WS pings',
      'metric.download': 'Download',
      'metric.download.sub': 'parallel fetch streams',
      'metric.upload': 'Upload',
      'metric.upload.sub': 'parallel POST uploads',
      'metric.live': 'live',
      'score.eyebrow': 'Network quality',
      'loc.prefix': 'Server location',
      'loc.detecting': 'Detecting…',
      'loc.unknown': 'Unknown location',
      'loc.badge.lan': 'Local network',
      'loc.badge.public': 'Internet',
      'loc.badge.azure': 'Azure',
      'loc.badge.unknown': 'Unknown',
      'score.labelInit': 'Run a test to rate this network',
      'score.breakdownInit': 'A single 0–100 rating combining latency, jitter, packet loss, download and upload — so you can compare networks at a glance.',
      'summary.title': 'Summary',
      'summary.init': 'Run a test to see results.',
      'footer.serverUnavailable': 'Server info unavailable.',
      'latency.subInit': 'min — / max —',
      'loss.subInit': '0 / ' + PING_COUNT + ' received',
      'tier.excellent': 'Excellent',
      'tier.good': 'Good',
      'tier.fair': 'Fair',
      'tier.poor': 'Poor',
      'tier.veryPoor': 'Very poor',
      'status.ready': 'Ready to test.',
      'status.starting': 'Starting…',
      'status.pinging': 'Pinging…',
      'status.pingingN': function (n, total) { return 'Pinging… ' + n + '/' + total; },
      'status.latencyDone': 'Latency complete.',
      'status.dlWarmup': 'Download warmup…',
      'status.downloading': 'Downloading…',
      'status.dlDone': 'Download complete.',
      'status.ulWarmup': 'Upload warmup…',
      'status.uploading': 'Uploading…',
      'status.ulDone': 'Upload complete.',
      'status.complete': 'Complete.',
      'status.stopping': 'Stopping…',
      'status.stopped': 'Stopped. Ready to test again.',
      'status.error': function (msg) { return 'Error: ' + msg; },
      'latency.waiting': 'waiting for pongs…',
      'latency.sub': function (min, max) { return 'min ' + min + ' / max ' + max; },
      'loss.sub': function (received, total) { return received + ' / ' + total + ' received'; },
      'score.breakdown': function (p) {
        return 'Download ' + p.download + ' · Upload ' + p.upload + ' · Latency ' + p.latency +
          ' · Jitter ' + p.jitter + ' · Loss ' + p.loss + ' (each /100)';
      },
      'server.info': function (platform, arch, version) { return 'Server: ' + platform + ' / ' + arch + ' · v' + version; },
      'server.time': function (dateText) { return 'Server time: ' + dateText; },
      'summary.result': function (v) {
        return 'Latency ' + v.avg + ' ms avg (' + v.min + '–' + v.max + ' ms), jitter ' + v.jitter +
          ' ms, loss ' + v.loss + '%, download ' + v.download + ' Mbps, upload ' + v.upload +
          ' Mbps. Server ' + v.platform + '/' + v.arch + ' (' + v.location + '), measured ' + v.date + '.';
      },
      'error.summary': 'The server could not complete the measurement. Confirm this page is loaded from the test server and that the LAN connection is active.',
      'error.unreachable': 'Cannot reach the server. Check that you are connected to this LAN test host.',
      'error.infoHttp': function (status) { return 'Server info request failed with HTTP ' + status + '.'; },
      'error.wsTimeout': 'WebSocket connection timed out. Is /ws available on this server?',
      'error.wsFailed': 'WebSocket connection failed. The server may be unreachable or /ws is not ready.',
      'error.downloadHttp': function (status) { return 'Download failed with HTTP ' + status + '.'; },
      'error.uploadHttp': function (status) { return 'Upload failed with HTTP ' + status + '.'; },
      'error.generic': 'The test could not complete.'
    },
    fr: {
      'hero.eyebrow': 'Test de débit LAN',
      'hero.title': 'Mesure de performance WiFi',
      'hero.subtitle': 'Mesurez la latence, la gigue, la perte de paquets et les débits descendant et montant vers ce serveur de même origine.',
      'btn.start': 'Lancer le test',
      'btn.stop': 'Arrêter',
      'metric.latency': 'Latence',
      'metric.latency.unit': 'moy',
      'metric.jitter': 'Gigue',
      'metric.jitter.unit': 'Δ moyen',
      'metric.jitter.sub': 'plus c’est bas, plus c’est stable',
      'metric.loss': 'Perte de paquets',
      'metric.loss.unit': 'pings WS',
      'metric.download': 'Téléchargement',
      'metric.download.sub': 'flux fetch parallèles',
      'metric.upload': 'Envoi',
      'metric.upload.sub': 'envois POST parallèles',
      'metric.live': 'en direct',
      'score.eyebrow': 'Qualité du réseau',
      'loc.prefix': 'Emplacement du serveur',
      'loc.detecting': 'Détection…',
      'loc.unknown': 'Emplacement inconnu',
      'loc.badge.lan': 'Réseau local',
      'loc.badge.public': 'Internet',
      'loc.badge.azure': 'Azure',
      'loc.badge.unknown': 'Inconnu',
      'score.labelInit': 'Lancez un test pour évaluer ce réseau',
      'score.breakdownInit': 'Une note unique de 0 à 100 combinant latence, gigue, perte de paquets, téléchargement et envoi — pour comparer les réseaux d’un coup d’œil.',
      'summary.title': 'Résumé',
      'summary.init': 'Lancez un test pour voir les résultats.',
      'footer.serverUnavailable': 'Infos serveur indisponibles.',
      'latency.subInit': 'min — / max —',
      'loss.subInit': '0 / ' + PING_COUNT + ' reçus',
      'tier.excellent': 'Excellent',
      'tier.good': 'Bon',
      'tier.fair': 'Correct',
      'tier.poor': 'Faible',
      'tier.veryPoor': 'Très faible',
      'status.ready': 'Prêt à tester.',
      'status.starting': 'Démarrage…',
      'status.pinging': 'Envoi de pings…',
      'status.pingingN': function (n, total) { return 'Pings… ' + n + '/' + total; },
      'status.latencyDone': 'Latence terminée.',
      'status.dlWarmup': 'Préchauffe du téléchargement…',
      'status.downloading': 'Téléchargement…',
      'status.dlDone': 'Téléchargement terminé.',
      'status.ulWarmup': 'Préchauffe de l’envoi…',
      'status.uploading': 'Envoi…',
      'status.ulDone': 'Envoi terminé.',
      'status.complete': 'Terminé.',
      'status.stopping': 'Arrêt…',
      'status.stopped': 'Arrêté. Prêt à relancer un test.',
      'status.error': function (msg) { return 'Erreur : ' + msg; },
      'latency.waiting': 'en attente des pongs…',
      'latency.sub': function (min, max) { return 'min ' + min + ' / max ' + max; },
      'loss.sub': function (received, total) { return received + ' / ' + total + ' reçus'; },
      'score.breakdown': function (p) {
        return 'Téléch. ' + p.download + ' · Envoi ' + p.upload + ' · Latence ' + p.latency +
          ' · Gigue ' + p.jitter + ' · Perte ' + p.loss + ' (chacun /100)';
      },
      'server.info': function (platform, arch, version) { return 'Serveur : ' + platform + ' / ' + arch + ' · v' + version; },
      'server.time': function (dateText) { return 'Heure serveur : ' + dateText; },
      'summary.result': function (v) {
        return 'Latence ' + v.avg + ' ms en moyenne (' + v.min + '–' + v.max + ' ms), gigue ' + v.jitter +
          ' ms, perte ' + v.loss + ' %, téléchargement ' + v.download + ' Mbps, envoi ' + v.upload +
          ' Mbps. Serveur ' + v.platform + '/' + v.arch + ' (' + v.location + '), mesuré le ' + v.date + '.';
      },
      'error.summary': 'Le serveur n’a pas pu terminer la mesure. Vérifiez que cette page est chargée depuis le serveur de test et que la connexion LAN est active.',
      'error.unreachable': 'Impossible de joindre le serveur. Vérifiez que vous êtes connecté à cet hôte de test du réseau local.',
      'error.infoHttp': function (status) { return 'La requête d’infos serveur a échoué (HTTP ' + status + ').'; },
      'error.wsTimeout': 'Délai de connexion WebSocket dépassé. /ws est-il disponible sur ce serveur ?',
      'error.wsFailed': 'Échec de la connexion WebSocket. Le serveur est peut-être injoignable ou /ws n’est pas prêt.',
      'error.downloadHttp': function (status) { return 'Échec du téléchargement (HTTP ' + status + ').'; },
      'error.uploadHttp': function (status) { return 'Échec de l’envoi (HTTP ' + status + ').'; },
      'error.generic': 'Le test n’a pas pu aboutir.'
    }
  };

  var LANG = detectLang();
  var LOCALE = LANG === 'fr' ? (matchesFrench(navigator.language) ? navigator.language : 'fr-FR') : navigator.language || 'en';

  function detectLang() {
    var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (var i = 0; i < langs.length; i += 1) {
      if (matchesFrench(langs[i])) {
        return 'fr';
      }
      if (matchesEnglish(langs[i])) {
        return 'en';
      }
    }
    return 'en';
  }

  function matchesFrench(tag) {
    return typeof tag === 'string' && tag.toLowerCase().indexOf('fr') === 0;
  }

  function matchesEnglish(tag) {
    return typeof tag === 'string' && tag.toLowerCase().indexOf('en') === 0;
  }

  function t(key) {
    var dict = I18N[LANG] || I18N.en;
    var value = dict[key];
    if (value === undefined) {
      value = I18N.en[key];
    }
    if (value === undefined) {
      return key;
    }
    if (typeof value === 'function') {
      return value.apply(null, Array.prototype.slice.call(arguments, 1));
    }
    return value;
  }

  function applyStaticI18n() {
    document.documentElement.lang = LANG;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
  }

  var el = {
    startStop: document.getElementById('startStop'),
    statusText: document.getElementById('statusText'),
    phasePercent: document.getElementById('phasePercent'),
    progressBar: document.getElementById('progressBar'),
    latencyValue: document.getElementById('latencyValue'),
    latencySub: document.getElementById('latencySub'),
    latencyRing: document.getElementById('latencyRing'),
    jitterValue: document.getElementById('jitterValue'),
    jitterRing: document.getElementById('jitterRing'),
    lossValue: document.getElementById('lossValue'),
    lossSub: document.getElementById('lossSub'),
    lossRing: document.getElementById('lossRing'),
    downloadValue: document.getElementById('downloadValue'),
    downloadRing: document.getElementById('downloadRing'),
    uploadValue: document.getElementById('uploadValue'),
    uploadRing: document.getElementById('uploadRing'),
    scoreCard: document.getElementById('scoreCard'),
    scoreValue: document.getElementById('scoreValue'),
    scoreGrade: document.getElementById('scoreGrade'),
    scoreLabel: document.getElementById('scoreLabel'),
    scoreBreakdown: document.getElementById('scoreBreakdown'),
    scoreRing: document.getElementById('scoreRing'),
    summary: document.getElementById('summary'),
    summaryText: document.getElementById('summaryText'),
    serverInfo: document.getElementById('serverInfo'),
    serverTime: document.getElementById('serverTime'),
    locationCard: document.getElementById('locationCard'),
    locationBadge: document.getElementById('locationBadge'),
    locationName: document.getElementById('locationName'),
    locationSub: document.getElementById('locationSub')
  };

  var run = {
    active: false,
    stopping: false,
    controllers: [],
    ws: null,
    results: {},
    serverInfo: null
  };

  el.startStop.addEventListener('click', function () {
    if (run.active) {
      stopRun();
      return;
    }
    startRun();
  });

  applyStaticI18n();
  fetchServerInfo(false);
  resetMetrics();

  async function startRun() {
    run.active = true;
    run.stopping = false;
    run.controllers = [];
    run.results = {};
    setRunningButton(true);
    resetMetrics();
    setProgress(t('status.starting'), 0);
    el.summary.hidden = true;

    try {
      run.serverInfo = await fetchServerInfo(true);
      throwIfStopped();
      run.results.latency = await runLatencyTest();
      throwIfStopped();
      run.results.download = await runDownloadTest();
      throwIfStopped();
      run.results.upload = await runUploadTest();
      throwIfStopped();
      setProgress(t('status.complete'), 100);
      showSummary();
    } catch (err) {
      if (isAbort(err) || run.stopping) {
        resetMetrics();
        el.summary.hidden = true;
        setProgress(t('status.stopped'), 0);
      } else {
        showError(err);
      }
    } finally {
      cleanupRun();
      setRunningButton(false);
    }
  }

  function stopRun() {
    run.stopping = true;
    setProgress(t('status.stopping'), currentProgress());
    el.startStop.disabled = true;
    if (run.ws && run.ws.readyState <= 1) {
      run.ws.close();
    }
    run.controllers.forEach(function (controller) {
      controller.abort();
    });
  }

  function cleanupRun() {
    run.active = false;
    run.stopping = false;
    run.controllers = [];
    run.ws = null;
  }

  async function fetchServerInfo(required) {
    try {
      var response = await fetch('/api/info', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(t('error.infoHttp', response.status));
      }
      var info = await response.json();
      var serverDate = info.serverTime ? new Date(info.serverTime) : null;
      el.serverInfo.textContent = t('server.info', safeText(info.platform), safeText(info.arch), safeText(info.version));
      el.serverTime.textContent = serverDate && !isNaN(serverDate.getTime()) ? t('server.time', serverDate.toLocaleString(LOCALE)) : '';
      renderLocation(info);
      return info;
    } catch (err) {
      el.serverInfo.textContent = t('footer.serverUnavailable');
      el.serverTime.textContent = '';
      renderLocation(null);
      if (required) {
        throw new Error(t('error.unreachable'));
      }
      return null;
    }
  }

  async function runLatencyTest() {
    setProgress(t('status.pinging'), 5);
    var scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    var ws = new WebSocket(scheme + '://' + location.host + '/ws');
    run.ws = ws;
    var pending = {};
    var rtts = new Array(PING_COUNT);
    var received = 0;

    ws.addEventListener('message', function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!msg || msg.type !== 'pong' || pending[msg.seq] === undefined) {
        return;
      }
      var item = pending[msg.seq];
      delete pending[msg.seq];
      clearTimeout(item.timer);
      var rtt = performance.now() - item.sentAt;
      rtts[msg.seq] = rtt;
      received += 1;
      updateLatencyLive(rtts, received, msg.seq + 1);
      item.resolve(rtt);
    });

    await waitForWebSocketOpen(ws);
    throwIfStopped();

    var promises = [];
    for (var seq = 0; seq < PING_COUNT; seq += 1) {
      throwIfStopped();
      promises.push(sendPing(ws, pending, seq));
      updateLatencyLive(rtts, received, seq + 1);
      await sleep(PING_INTERVAL_MS);
    }

    await Promise.all(promises);
    if (ws.readyState <= 1) {
      ws.close();
    }

    var receivedRtts = rtts.filter(function (value) { return typeof value === 'number'; });
    var stats = summarizeLatency(receivedRtts, PING_COUNT, received);
    updateMetric('latency', stats.avg, 150);
    updateMetric('jitter', stats.jitter, 50);
    updateMetric('loss', stats.loss, 100);
    el.latencySub.textContent = t('latency.sub', formatNumber(stats.min, 1), formatNumber(stats.max, 1));
    el.lossSub.textContent = t('loss.sub', received, PING_COUNT);
    setProgress(t('status.latencyDone'), 25);
    return stats;
  }

  function waitForWebSocketOpen(ws) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error(t('error.wsTimeout')));
      }, 5000);

      ws.addEventListener('open', function () {
        clearTimeout(timer);
        resolve();
      }, { once: true });

      ws.addEventListener('error', function () {
        clearTimeout(timer);
        reject(new Error(t('error.wsFailed')));
      }, { once: true });
    });
  }

  function sendPing(ws, pending, seq) {
    return new Promise(function (resolve) {
      var sentAt = performance.now();
      var timer = setTimeout(function () {
        delete pending[seq];
        resolve(null);
      }, PING_TIMEOUT_MS);
      pending[seq] = { sentAt: sentAt, timer: timer, resolve: resolve };
      ws.send(JSON.stringify({ type: 'ping', seq: seq, clientTime: Date.now() }));
    });
  }

  async function runDownloadTest() {
    setProgress(t('status.dlWarmup'), 30);
    var controller = new AbortController();
    run.controllers.push(controller);
    var measuredBytes = { value: 0 };
    var started = performance.now();
    var measureStart = started + WARMUP_MS;
    var endAt = started + DOWNLOAD_MS;
    var timer = setTimeout(function () { controller.abort(); }, DOWNLOAD_MS);
    var liveTimer = setInterval(function () {
      var now = performance.now();
      var elapsed = Math.max(0, (now - measureStart) / 1000);
      var mbps = elapsed > 0 ? measuredBytes.value * 8 / elapsed / 1000000 : 0;
      updateMetric('download', mbps, 1000);
      setProgress(now < measureStart ? t('status.dlWarmup') : t('status.downloading'), progressBetween(now, measureStart, endAt, 30, 62));
    }, 250);

    try {
      await Promise.all(makeWorkers(PARALLEL_STREAMS, function () {
        return downloadWorker(controller.signal, measuredBytes, measureStart, endAt);
      }));
    } finally {
      clearTimeout(timer);
      clearInterval(liveTimer);
      removeController(controller);
    }

    throwIfStopped();
    var elapsedSeconds = Math.max(0.001, (Math.min(performance.now(), endAt) - measureStart) / 1000);
    var mbpsFinal = measuredBytes.value * 8 / elapsedSeconds / 1000000;
    updateMetric('download', mbpsFinal, 1000);
    setProgress(t('status.dlDone'), 65);
    return { mbps: mbpsFinal, bytes: measuredBytes.value, seconds: elapsedSeconds };
  }

  async function downloadWorker(signal, measuredBytes, measureStart, endAt) {
    while (!signal.aborted && performance.now() < endAt) {
      try {
        var response = await fetch('/api/download?bytes=' + DOWNLOAD_BYTES, { cache: 'no-store', signal: signal });
        if (!response.ok) {
          throw new Error(t('error.downloadHttp', response.status));
        }
        if (!response.body || !response.body.getReader) {
          var buffer = await response.arrayBuffer();
          if (performance.now() >= measureStart) {
            measuredBytes.value += buffer.byteLength;
          }
          continue;
        }
        var reader = response.body.getReader();
        while (!signal.aborted) {
          var chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          if (performance.now() >= measureStart && chunk.value) {
            measuredBytes.value += chunk.value.byteLength;
          }
        }
      } catch (err) {
        if (isAbort(err) || signal.aborted || performance.now() >= endAt) {
          break;
        }
        throw err;
      }
    }
  }

  async function runUploadTest() {
    setProgress(t('status.ulWarmup'), 68);
    var payload = makeRandomPayload(UPLOAD_BYTES);
    var controller = new AbortController();
    run.controllers.push(controller);
    var measuredBytes = { value: 0 };
    var started = performance.now();
    var measureStart = started + WARMUP_MS;
    var endAt = started + UPLOAD_MS;
    var timer = setTimeout(function () { controller.abort(); }, UPLOAD_MS);
    var liveTimer = setInterval(function () {
      var now = performance.now();
      var elapsed = Math.max(0, (now - measureStart) / 1000);
      var mbps = elapsed > 0 ? measuredBytes.value * 8 / elapsed / 1000000 : 0;
      updateMetric('upload', mbps, 1000);
      setProgress(now < measureStart ? t('status.ulWarmup') : t('status.uploading'), progressBetween(now, measureStart, endAt, 68, 97));
    }, 250);

    try {
      await Promise.all(makeWorkers(PARALLEL_STREAMS, function () {
        return uploadWorker(controller.signal, payload, measuredBytes, measureStart, endAt);
      }));
    } finally {
      clearTimeout(timer);
      clearInterval(liveTimer);
      removeController(controller);
    }

    throwIfStopped();
    var elapsedSeconds = Math.max(0.001, (Math.min(performance.now(), endAt) - measureStart) / 1000);
    var mbpsFinal = measuredBytes.value * 8 / elapsedSeconds / 1000000;
    updateMetric('upload', mbpsFinal, 1000);
    setProgress(t('status.ulDone'), 100);
    return { mbps: mbpsFinal, bytes: measuredBytes.value, seconds: elapsedSeconds };
  }

  async function uploadWorker(signal, payload, measuredBytes, measureStart, endAt) {
    while (!signal.aborted && performance.now() < endAt) {
      var requestStarted = performance.now();
      try {
        var response = await fetch('/api/upload', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload,
          signal: signal
        });
        if (!response.ok) {
          throw new Error(t('error.uploadHttp', response.status));
        }
        await response.text();
        if (requestStarted >= measureStart) {
          measuredBytes.value += payload.byteLength;
        }
      } catch (err) {
        if (isAbort(err) || signal.aborted || performance.now() >= endAt) {
          break;
        }
        throw err;
      }
    }
  }

  function makeRandomPayload(size) {
    var payload = new Uint8Array(size);
    if (window.crypto && window.crypto.getRandomValues) {
      for (var offset = 0; offset < payload.length; offset += 65536) {
        window.crypto.getRandomValues(payload.subarray(offset, Math.min(offset + 65536, payload.length)));
      }
    } else {
      for (var i = 0; i < payload.length; i += 1) {
        payload[i] = Math.floor(Math.random() * 256);
      }
    }
    return payload;
  }

  function summarizeLatency(rtts, sent, received) {
    var loss = sent > 0 ? (sent - received) / sent * 100 : 0;
    if (!rtts.length) {
      return { avg: 0, min: 0, max: 0, jitter: 0, loss: loss, received: received, sent: sent };
    }
    var sum = rtts.reduce(function (acc, value) { return acc + value; }, 0);
    var min = Math.min.apply(Math, rtts);
    var max = Math.max.apply(Math, rtts);
    var jitterSum = 0;
    for (var i = 1; i < rtts.length; i += 1) {
      jitterSum += Math.abs(rtts[i] - rtts[i - 1]);
    }
    return {
      avg: sum / rtts.length,
      min: min,
      max: max,
      jitter: rtts.length > 1 ? jitterSum / (rtts.length - 1) : 0,
      loss: loss,
      received: received,
      sent: sent
    };
  }

  function updateLatencyLive(rtts, received, sentSoFar) {
    var stats = summarizeLatency(rtts.filter(function (value) { return typeof value === 'number'; }), sentSoFar, received);
    updateMetric('latency', stats.avg, 150);
    updateMetric('jitter', stats.jitter, 50);
    updateMetric('loss', stats.loss, 100);
    el.latencySub.textContent = received ? t('latency.sub', formatNumber(stats.min, 1), formatNumber(stats.max, 1)) : t('latency.waiting');
    el.lossSub.textContent = t('loss.sub', received, PING_COUNT);
    setProgress(t('status.pingingN', sentSoFar, PING_COUNT), 5 + sentSoFar / PING_COUNT * 20);
  }

  function updateMetric(name, value, scale) {
    var safe = isFinite(value) ? Math.max(0, value) : 0;
    var text = safe === 0 ? '0' : formatNumber(safe, safe >= 100 ? 0 : 1);
    var percent = Math.max(0, Math.min(1, safe / scale));
    if (name === 'latency') {
      el.latencyValue.textContent = text;
      setRing(el.latencyRing, percent);
    } else if (name === 'jitter') {
      el.jitterValue.textContent = text;
      setRing(el.jitterRing, percent);
    } else if (name === 'loss') {
      el.lossValue.textContent = formatNumber(safe, safe >= 10 ? 0 : 1);
      setRing(el.lossRing, percent);
    } else if (name === 'download') {
      el.downloadValue.textContent = text;
      setRing(el.downloadRing, percent);
    } else if (name === 'upload') {
      el.uploadValue.textContent = text;
      setRing(el.uploadRing, percent);
    }
  }

  function resetMetrics() {
    el.latencyValue.textContent = '—';
    el.jitterValue.textContent = '—';
    el.lossValue.textContent = '—';
    el.downloadValue.textContent = '—';
    el.uploadValue.textContent = '—';
    el.latencySub.textContent = t('latency.subInit');
    el.lossSub.textContent = t('loss.subInit');
    [el.latencyRing, el.jitterRing, el.lossRing, el.downloadRing, el.uploadRing].forEach(function (ring) {
      setRing(ring, 0);
    });
    if (el.scoreCard) {
      el.scoreCard.hidden = true;
      el.scoreValue.textContent = '—';
      el.scoreGrade.textContent = '—';
      el.scoreLabel.textContent = t('score.labelInit');
      el.scoreRing.style.strokeDashoffset = String(SCORE_CIRCUMFERENCE);
      el.scoreCard.style.removeProperty('--score-color');
    }
    setProgress(t('status.ready'), 0);
  }

  function renderLocation(info) {
    var exposure = (info && info.exposure) || 'unknown';
    var loc = (info && info.location) || null;
    var badgeKey = exposure === 'lan' ? 'loc.badge.lan'
      : exposure === 'azure' ? 'loc.badge.azure'
      : exposure === 'public' ? 'loc.badge.public'
      : 'loc.badge.unknown';
    el.locationBadge.textContent = t(badgeKey);
    el.locationBadge.className = 'loc-badge ' + (exposure === 'lan' ? 'loc-lan' : exposure === 'unknown' ? 'loc-unknown' : 'loc-cloud');
    el.locationName.textContent = (loc && loc.displayName) ? loc.displayName : t('loc.unknown');
    el.locationSub.textContent = locationSubText(info);
  }

  function locationSubText(info) {
    if (!info) { return ''; }
    var loc = info.location || {};
    var parts = [];
    if (loc.city) { parts.push(loc.city); }
    if (loc.country) { parts.push(loc.country); }
    var geo = parts.join(', ');
    if (info.hostname) { return geo ? geo + ' · ' + info.hostname : info.hostname; }
    return geo;
  }

  function summaryLocationText(info) {
    if (!info) { return t('loc.unknown'); }
    var loc = info.location || {};
    var name = loc.displayName || t('loc.unknown');
    var parts = [];
    if (loc.city) { parts.push(loc.city); }
    if (loc.country) { parts.push(loc.country); }
    return parts.length ? name + ' — ' + parts.join(', ') : name;
  }

  function showSummary() {
    var latency = run.results.latency || {};
    var download = run.results.download || {};
    var upload = run.results.upload || {};
    var info = run.serverInfo || {};
    renderScore(computeQualityScore(latency, download, upload));
    el.summaryText.textContent = t('summary.result', {
      avg: formatNumber(latency.avg, 1),
      min: formatNumber(latency.min, 1),
      max: formatNumber(latency.max, 1),
      jitter: formatNumber(latency.jitter, 1),
      loss: formatNumber(latency.loss, 1),
      download: formatNumber(download.mbps, 1),
      upload: formatNumber(upload.mbps, 1),
      platform: safeText(info.platform),
      arch: safeText(info.arch),
      location: summaryLocationText(info),
      date: new Date().toLocaleString(LOCALE)
    });
    el.summary.hidden = false;
  }

  // Combine all metrics into a single 0–100 rating so different networks can be compared.
  function computeQualityScore(latency, download, upload) {
    var parts = {
      download: scoreFromAnchors(numberOr(download.mbps, 0), SCORE_ANCHORS.download),
      upload: scoreFromAnchors(numberOr(upload.mbps, 0), SCORE_ANCHORS.upload),
      latency: scoreFromAnchors(numberOr(latency.avg, 9999), SCORE_ANCHORS.latency),
      jitter: scoreFromAnchors(numberOr(latency.jitter, 9999), SCORE_ANCHORS.jitter),
      loss: scoreFromAnchors(numberOr(latency.loss, 100), SCORE_ANCHORS.loss)
    };
    var total = 0;
    Object.keys(SCORE_WEIGHTS).forEach(function (key) {
      total += parts[key] * SCORE_WEIGHTS[key];
    });
    var score = Math.max(0, Math.min(100, Math.round(total)));
    return { score: score, tier: tierForScore(score), parts: parts };
  }

  function renderScore(result) {
    var tier = result.tier;
    el.scoreCard.style.setProperty('--score-color', tier.color);
    el.scoreValue.textContent = String(result.score);
    el.scoreGrade.textContent = tier.grade;
    el.scoreLabel.textContent = t(tier.labelKey);
    el.scoreBreakdown.textContent = t('score.breakdown', {
      download: Math.round(result.parts.download),
      upload: Math.round(result.parts.upload),
      latency: Math.round(result.parts.latency),
      jitter: Math.round(result.parts.jitter),
      loss: Math.round(result.parts.loss)
    });
    el.scoreRing.style.strokeDasharray = String(SCORE_CIRCUMFERENCE);
    el.scoreRing.style.strokeDashoffset = String(SCORE_CIRCUMFERENCE - SCORE_CIRCUMFERENCE * (result.score / 100));
    el.scoreCard.hidden = false;
  }

  function scoreFromAnchors(value, anchors) {
    var ascending = anchors[anchors.length - 1][1] >= anchors[0][1];
    if (value <= anchors[0][0]) {
      return anchors[0][1];
    }
    if (value >= anchors[anchors.length - 1][0]) {
      return anchors[anchors.length - 1][1];
    }
    for (var i = 1; i < anchors.length; i += 1) {
      var prev = anchors[i - 1];
      var curr = anchors[i];
      if (value <= curr[0]) {
        var span = curr[0] - prev[0];
        var ratio = span > 0 ? (value - prev[0]) / span : 0;
        return prev[1] + ratio * (curr[1] - prev[1]);
      }
    }
    return ascending ? anchors[anchors.length - 1][1] : anchors[0][1];
  }

  function tierForScore(score) {
    for (var i = 0; i < SCORE_TIERS.length; i += 1) {
      if (score >= SCORE_TIERS[i].min) {
        return SCORE_TIERS[i];
      }
    }
    return SCORE_TIERS[SCORE_TIERS.length - 1];
  }

  function numberOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function showError(err) {
    setProgress(t('status.error', (err && err.message) ? err.message : t('error.generic')), 0);
    el.summaryText.textContent = t('error.summary');
    el.summary.hidden = false;
  }

  function setRunningButton(isRunning) {
    el.startStop.disabled = false;
    el.startStop.textContent = isRunning ? t('btn.stop') : t('btn.start');
    el.startStop.classList.toggle('stop', isRunning);
  }

  function setProgress(text, percent) {
    var rounded = Math.max(0, Math.min(100, Math.round(percent || 0)));
    el.statusText.textContent = text;
    el.phasePercent.textContent = rounded + '%';
    el.progressBar.style.width = rounded + '%';
  }

  function currentProgress() {
    var value = parseFloat(el.progressBar.style.width || '0');
    return isFinite(value) ? value : 0;
  }

  function progressBetween(now, start, end, low, high) {
    if (now <= start) {
      return low;
    }
    var span = Math.max(1, end - start);
    return low + Math.min(1, (now - start) / span) * (high - low);
  }

  function setRing(ring, percent) {
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE - RING_CIRCUMFERENCE * percent);
  }

  function formatNumber(value, digits) {
    if (!isFinite(value)) {
      return '0';
    }
    return Number(value).toFixed(digits);
  }

  function safeText(value) {
    return value === undefined || value === null || value === '' ? 'unknown' : String(value);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function makeWorkers(count, factory) {
    var workers = [];
    for (var i = 0; i < count; i += 1) {
      workers.push(factory());
    }
    return workers;
  }

  function removeController(controller) {
    run.controllers = run.controllers.filter(function (item) { return item !== controller; });
  }

  function throwIfStopped() {
    if (run.stopping) {
      var err = new Error('Stopped');
      err.name = 'AbortError';
      throw err;
    }
  }

  function isAbort(err) {
    return err && (err.name === 'AbortError' || err.message === 'The operation was aborted.');
  }
}());
