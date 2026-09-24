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

- **ข้อมูลตลาด**: ราคาจำลอง 5 สินทรัพย์ (ดัชนีหุ้น, หุ้นเทค, คริปโต, ทองคำ, ตลาด Sideway) จากโมเดล regime-switching GBM และ mean-reverting หรือ **อัปโหลดไฟล์ CSV** ของตัวเอง
- **กลยุทธ์**: SMA Crossover, Time-Series Momentum, RSI Mean Reversion, Bollinger Reversion, Buy & Hold ปรับพารามิเตอร์ได้ ตั้งค่าธรรมเนียม (bps) ได้ และเลือกได้ว่าจะอนุญาต Short หรือไม่
- **ตัวชี้วัด**: ผลตอบแทนรวม, CAGR, Sharpe, Sortino, Max Drawdown, ความผันผวน, Calmar, Win rate, Profit factor, Exposure เทียบกับ Buy & Hold
- **กราฟ**: Equity curve (มีสเกล Log), ราคาพร้อมอินดิเคเตอร์และจุดซื้อขาย, Drawdown, Histogram ผลตอบแทนรายวัน, Heatmap ผลตอบแทนรายเดือน
- ตารางเปรียบเทียบทุกกลยุทธ์ บันทึกการเทรด และดาวน์โหลดผลเป็น CSV
- รองรับธีมสว่าง/มืดและมือถือ ทุกกราฟมี tooltip (เมาส์หรือปุ่มลูกศร) และดูเป็นตารางได้

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
```

> ข้อมูลเริ่มต้นเป็นราคาจำลองเพื่อการศึกษา ไม่ใช่คำแนะนำการลงทุน
