// npm run insiders:check — src/utils/insiders.js
import { insiderSignals, shortSignals, insiderVerdict, INSIDER } from '../src/utils/insiders.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const t = (owner, code, date, filed, shares = 1000, price = 100) => ({ owner, code, date, filed, shares, price })

const cluster = [t('A', 'S', '2025-05-10', '2025-05-12'), t('B', 'S', '2025-05-20', '2025-05-22'), t('C', 'S', '2025-06-01', '2025-06-03')]
const s1 = insiderSignals(cluster, '2025-07-01')
ok('three insiders selling in 90 days, no buyer: sell cluster', s1.sellCluster && s1.sellers === 3 && s1.buyers === 0)
ok('$300k sold, nothing bought: not net selling (under $1M)', !s1.netSelling)
ok('a buyer in the window breaks the cluster', !insiderSignals([...cluster, t('D', 'P', '2025-06-10', '2025-06-12')], '2025-07-01').sellCluster)
ok('a filing after the day does not count', insiderSignals([...cluster.slice(0, 2), t('C', 'S', '2025-06-01', '2025-07-05')], '2025-07-01').sellers === 2)
ok('a trade older than 90 days leaves the cluster', insiderSignals([t('A', 'S', '2025-03-01', '2025-03-03'), ...cluster.slice(1)], '2025-07-01').sellers === 2)
ok('same insider twice counts once', insiderSignals([t('A', 'S', '2025-05-10', '2025-05-12'), t('A', 'S', '2025-05-20', '2025-05-22'), t('B', 'S', '2025-06-01', '2025-06-03')], '2025-07-01').sellers === 2)
ok('$2M sold vs $100k bought over 180 days: net selling', insiderSignals([t('A', 'S', '2025-02-01', '2025-02-03', 20000, 100), t('B', 'P', '2025-04-01', '2025-04-03', 1000, 100)], '2025-07-01').netSelling)
ok('two buyers: buy cluster', insiderSignals([t('A', 'P', '2025-06-01', '2025-06-03'), t('B', 'P', '2025-06-10', '2025-06-12')], '2025-07-01').buyCluster)
ok('no filings → unknown', insiderSignals([], '2025-07-01').known === false)

const shorts = [{ date: '2025-03-14', shares: 1e6 }, { date: '2025-03-31', shares: 1.1e6 }, { date: '2025-06-13', shares: 1.6e6 }, { date: '2025-06-30', shares: 1.7e6 }]
const sh = shortSignals(shorts, '2025-07-01', 10e6)
ok('short interest up 70% vs 3 months earlier: rising', sh.shortRising && sh.short === 1.7e6)
ok('17% of shares out: heavily shorted', sh.shortHigh && Math.abs(sh.ratio - 0.17) < 1e-9)
ok('no share count → ratio unknown, not high', shortSignals(shorts, '2025-07-01', null).shortHigh === false)
ok('a stale feed (last point 2 months old) → unknown', shortSignals(shorts.slice(0, 2), '2025-07-01', 10e6).known === false)
ok('future settlement dates are ignored', shortSignals(shorts, '2025-06-20', 10e6).short === 1.6e6)

ok('a rare but right flag passes without recall', insiderVerdict({ flagged: 300, lift: 2.5, recall: 0.04, medianRet: -0.08, medianAll: 0.04 }) === 'pass')
ok('under 200 flagged months → inconclusive', insiderVerdict({ flagged: 150, lift: 3, medianRet: -0.2, medianAll: 0.04 }) === 'inconclusive')
ok('lift without a worse return fails', insiderVerdict({ flagged: 300, lift: 2.5, medianRet: 0.05, medianAll: 0.04 }) === 'fail')
ok('the buy-cluster mirror passes on a better return', insiderVerdict({ flagged: 300, lift: 1, medianRet: 0.12, medianAll: 0.04 }, { mirror: true }) === 'pass')
ok('thresholds are the pre-registered ones', INSIDER.sellCluster === 3 && INSIDER.netRatio === 10 && INSIDER.shortRise === 0.5 && INSIDER.shortHigh === 0.1)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
