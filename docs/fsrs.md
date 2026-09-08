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

## 參數

用官方預設的 21 個權重，沒有做個人化最佳化（optimizer）。理由：最佳化需要數千筆自己的作答紀錄才穩，紀錄不夠時它給出的參數比預設值差。`data/reviews.jsonl` 攢夠之後可以再考慮，資料格式已經留好了。
