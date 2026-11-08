# FSRS-6：移植與驗證

## 為什麼不自己排間隔

Leitner 的 0/1/2/4/8/21 天對每張卡一視同仁。但「être 的 subjonctif présent」與「abondant 的中文意思」不是同一種難度，同一個人對它們的遺忘速度差好幾倍。固定間隔表的代價是：簡單的卡問太多次，難的卡問太少次。

FSRS 為每張卡各自估一組參數，間隔由「你要幾成把握記得」反推。

## 三個量

| 符號 | 名稱 | 定義 |
|---|---|---|
| S | 穩定度 | 從剛複習完，到可提取度掉至 90% 所需的天數 |
| D | 難度 | 1–10，這張卡對**你**有多難，隨每次評分緩慢修正 |
| R | 可提取性 | 此刻若考你，答得出來的機率 |

R 是 S 與經過天數的函數，用的是冪律遺忘曲線，不是指數：

```
R(t) = (1 + FACTOR × t / S) ^ DECAY
```

`DECAY` 是 21 個模型參數裡的最後一個（`w[20]`），`FACTOR` 由它導出。冪律的意思是「久沒複習的卡，忘記速度會變慢」——這是指數曲線給不出來的行為，也是 FSRS 與 SM-2 家族的主要差別之一。

下次間隔由目標可提取度 `target`（預設 0.9）反解：

```
I = (S / FACTOR) × (target^(1/DECAY) − 1)
```

## 評分

1 = Again，2 = Hard，3 = Good，4 = Easy。

自評題（看字回想）由使用者直接給分。打字題由批改結果換算：全對給 Good、只差大小寫給 Hard、其餘（含只差重音）給 Again。換算表在 [grading.md](grading.md)。

## 移植與驗證

`src/engine/fsrs.mjs` 是 py-fsrs（MIT）`fsrs/scheduler.py` 的逐行移植，2026-09-08 取自 `open-spaced-repetition/py-fsrs @ main`。

驗證方式是 **732 組黃金向量**，存在 `tests/fixtures/fsrs-golden.json`。這些向量**由參考實作的原始碼直接執行產生，不是手抄**——手抄會把抄錯的地方一起抄進測試，變成自我證明。

`_source`、`_generated`、`_note` 三個欄位記著它們是怎麼來的。`maximum_interval` 統一設成 36500 以對齊 py-fsrs 預設值；本專案執行期用的是 3650（10 年），因為 10 年後才複習的卡等同沒在複習。

## 一個容易錯的細節

py-fsrs 用 Python 內建的 `round()`，那是**銀行家捨入**（round half to even），不是 JavaScript 的 `Math.round()`（round half up）。`roundHalfToEven()` 在 `fsrs.mjs` 裡就是為了這件事。間隔剛好落在 .5 的情況不常見，但一旦發生就會與參考實作分岔，而且分岔之後每一步都會偏。黃金向量抓得到這個。

## 與 py-fsrs 的一處刻意差異：經過天數用小數

py-fsrs 的經過天數取 `(review_datetime - card.last_review).days`，也就是 `timedelta.days`，小數部分直接捨去：隔 1 天 22 小時算 1 天。cadence 用毫秒差除以一天（`src/db.mjs` 第 349、423 行，`src/cloud/learning.mjs` 第 78、147 行），隔 1 天 22 小時就是 1.92 天，原樣傳進 `review()`。

保留小數的理由：R 本來就是連續函數，捨去小數等於把每次複習都當成提早到，S 小的卡被高估得最多。cadence 一天會複習同一張卡好幾次的情況不少（同日公式、打字題重考），整數天會讓同一天內的先後順序失去意義。

差異有多大，用 `src/engine/fsrs.mjs` 實算（D = 5、評 Good、`target` 0.9）：

| 情況 | cadence（小數） | py-fsrs 的算法（取整） |
|---|---|---|
| S = 1.5，隔 1.9 天 | R = 0.883，新 S = 6.84，下次 7 天後 | 當成 1 天：R = 0.925，新 S = 4.85，下次 5 天後 |
| S = 30，隔 30.9 天 | R = 0.898，新 S = 86.2，下次 86 天後 | 當成 30 天：R = 0.900，新 S = 85.0，下次 85 天後 |

S 小的卡差到 2 天，S 大的卡只差 1 天以內。方向固定：小數天數的 R 較低，答對時 S 漲得較多、間隔較長。

影響範圍：

- 黃金向量（`tests/fixtures/fsrs-golden.json`）全部用整數天數，測的是公式移植正確，不涵蓋這個差異。
- `elapsedDays < 1` 走同日公式，兩邊判斷一致；差異只出現在隔 1 天以上、且不是整數天的複習。
- 拿 cadence 的紀錄去給 py-fsrs 或官方 optimizer 用時，要先把 `elapsed` 取整，否則重播出來的 S 與 cadence 存的不同。

## 參數

用官方預設的 21 個權重，沒有做個人化最佳化（optimizer）。理由：最佳化需要數千筆自己的作答紀錄才穩，紀錄不夠時它給出的參數比預設值差。`data/reviews.jsonl` 攢夠之後可以再考慮，資料格式已經留好了。
