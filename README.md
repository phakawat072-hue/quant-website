# QuantLab — Quant Dashboard

แดชบอร์ดสำหรับทดสอบกลยุทธ์เทรดเชิงปริมาณย้อนหลัง (Backtest) เขียนด้วย HTML/CSS/JavaScript ล้วน ไม่ต้องติดตั้งหรือ build อะไรเลย

## วิธีเปิดใช้งาน

ดับเบิลคลิกเปิด `index.html` ในเบราว์เซอร์ได้ทันที หรือรันเป็นเว็บเซิร์ฟเวอร์:

```bash
python3 -m http.server 8000
# แล้วเปิด http://localhost:8000
```

สามารถ deploy ขึ้น GitHub Pages / Netlify / Vercel ได้เลยเพราะเป็นไฟล์ static

## ฟีเจอร์

- **หุ้นสหรัฐทุกตัว**: ช่องค้นหารองรับหุ้นและ ETF ที่จดทะเบียนใน NYSE / NASDAQ / NYSE American ทั้งหมด (รายชื่อจาก NASDAQ Trader)
  - 46 ตัวยอดนิยม (AAPL, MSFT, NVDA, TSLA, JPM, KO ฯลฯ รวม SPY/QQQ) เก็บราคาไว้ใน repo โหลดได้ทันที (Yahoo Finance ตั้งแต่ปี 2010)
  - ตัวอื่นดึงสดจาก [Twelve Data](https://twelvedata.com) ด้วย API key ฟรีของผู้ใช้ (8 ครั้ง/นาที, 800 ครั้ง/วัน) key เก็บใน localStorage ของเบราว์เซอร์เท่านั้น และแคชข้อมูลไว้ 12 ชั่วโมง
  - การดึงสดต้องเปิดผ่าน GitHub Pages หรือไฟล์ในเครื่อง (ลิงก์พรีวิวบน claude.ai อาจบล็อกการเชื่อมต่อภายนอก)
- อัปโหลด **ไฟล์ CSV** ของตัวเองได้ และยังมีราคาจำลองไว้ทดลองระบบ
- **กลยุทธ์**: SMA Crossover, Time-Series Momentum, RSI Mean Reversion, Bollinger Reversion, Buy & Hold ปรับพารามิเตอร์ได้ ตั้งค่าธรรมเนียม (bps) ได้ และเลือกได้ว่าจะอนุญาต Short หรือไม่
- **ตัวชี้วัด**: ผลตอบแทนรวม, CAGR, Sharpe, Sortino, Max Drawdown, ความผันผวน, Calmar, Win rate, Profit factor, Exposure เทียบกับ Buy & Hold
- **กราฟ**: Equity curve (มีสเกล Log), ราคาพร้อมอินดิเคเตอร์และจุดซื้อขาย, Drawdown, Histogram ผลตอบแทนรายวัน, Heatmap ผลตอบแทนรายเดือน
- ตารางเปรียบเทียบทุกกลยุทธ์ บันทึกการเทรด และดาวน์โหลดผลเป็น CSV
- รองรับธีมสว่าง/มืดและมือถือ ทุกกราฟมี tooltip (เมาส์หรือปุ่มลูกศร) และดูเป็นตารางได้

## ข้อมูลราคาหุ้น

- GitHub Actions (`.github/workflows/update-prices.yml`) รัน `scripts/fetch_prices.py` (ใช้ไลบรารี yfinance) ทุกวันจันทร์–ศุกร์ หลังตลาดสหรัฐปิด แล้ว commit ไฟล์ลง `data/prices/`
- สั่งอัปเดตเองได้ที่แท็บ **Actions → Update stock prices → Run workflow** หรือรันในเครื่อง `pip install yfinance && python scripts/fetch_prices.py`
- เพิ่ม/ลบหุ้นได้ที่ `scripts/tickers.json` แล้วรัน workflow อีกครั้ง

## รูปแบบไฟล์ CSV

ต้องมีคอลัมน์วันที่ (`Date`) และราคาปิด (`Close` หรือ `Adj Close`) อย่างน้อย 60 แถว เช่นไฟล์ที่ดาวน์โหลดจาก Yahoo Finance:

```csv
Date,Open,High,Low,Close,Adj Close,Volume
2024-01-02,100.5,101.2,99.8,100.9,100.9,1234567
```

## หลักการ Backtest

- สัญญาณคำนวณจากราคาปิดของวัน t และมีผลกับผลตอบแทนของวัน t+1 จึงไม่มี look-ahead bias
- ค่าธรรมเนียมคิดตาม turnover ทุกครั้งที่เปลี่ยนสถานะ
- ตัวชี้วัดรายปีคำนวณจากจำนวนแท่งต่อปีของข้อมูลจริง (รองรับข้อมูลที่มีวันหยุดสุดสัปดาห์ เช่นคริปโต)

## โครงสร้างไฟล์

```
index.html          หน้าเว็บหลัก
css/style.css       สไตล์และธีม
js/data.js          ราคาจำลองและตัวอ่าน CSV
js/strategies.js    อินดิเคเตอร์และกลยุทธ์
js/backtest.js      เอนจิน Backtest และตัวชี้วัด
js/charts.js        กราฟ SVG (line, histogram, heatmap, table)
js/app.js           จัดการ state และ UI
js/search.js        ช่องค้นหาหุ้น
js/live.js          ดึงราคาสดจาก Twelve Data
data/prices/        ราคาหุ้นยอดนิยม (สร้างอัตโนมัติ ห้ามแก้ด้วยมือ)
data/symbols.js     รายชื่อหุ้นสหรัฐทั้งหมด (สร้างอัตโนมัติ)
scripts/            สคริปต์ดึงราคาและรายชื่อหุ้น
```

> เพื่อการศึกษาเท่านั้น ไม่ใช่คำแนะนำการลงทุน
