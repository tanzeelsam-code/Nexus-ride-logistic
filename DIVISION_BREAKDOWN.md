# NEXUS LOGISTICS GROUP
## Two-Division Architecture: RIDE vs FREIGHT

---

## ✅ CONFIRMATION: YES, BOTH DIVISIONS ARE FULLY INCLUDED

The platform has **two completely separate, independent divisions** sharing one AI backbone (NEXUS CORE).

---

## 🚕 DIVISION 1: NEXUS RIDE (Taxi Service)

### What It Does
Passenger transportation — people moving from point A to B.

### Service Types
| Service | Description | Vehicle |
|---------|-------------|---------|
| Standard Ride | Regular 4-seat car | Sedan/Hatchback |
| Premium Ride | Luxury vehicle | Luxury/Tesla |
| SUV Ride | Large vehicle, 6-7 seats | SUV |
| Shared/Pool | AI seat-match multiple passengers | Sedan |
| Medical Transport | Priority medical trips + insurance | Van |
| Airport Shuttle | Fixed-route + on-demand | Sedan/SUV |

### Customer Journey (Taxi)
```
1. Customer opens NEXUS RIDE app
2. Enters pickup & dropoff location
3. AI PricingEngine calculates fare + surge
4. Customer confirms & pays
5. AI DispatchBrain finds optimal nearby driver
6. Driver accepts → en route notification sent
7. Driver arrives → OTP verification
8. Trip starts — AI SafetyShield monitors route
9. Trip completes → automatic payment
10. Customer rates driver → AI updates driver score
```

### Driver Features (Ride)
- Accept/reject ride requests
- Live navigation
- Real-time earnings tracker
- Rating dashboard
- SOS emergency button
- Daily/weekly payout

### Pricing Model (Ride)
- Base fare: $2.50
- Per km: $1.20
- Per minute: $0.25
- Minimum fare: $5.00
- Surge: 1.0× – 3.5× (AI-managed)
- Cancellation fee: $3.00
- Platform commission: 18-22%

### Key AI Modules Used
- DispatchBrainNet → Match passenger to nearest best driver
- ETA Prophet → "Your driver arrives in 4 min"
- PricingEngine → Dynamic surge pricing
- SafetyShield → Route deviation, harsh braking detection
- NexusChat → Support: "My driver took wrong route"

### Dashboard Color: Electric Cyan (#00D4FF)

---

## 📦 DIVISION 2: NEXUS FREIGHT (Goods / Logistics)

### What It Does
Moving goods, cargo, and packages — things (not people) from A to B.

### Service Types
| Service | Description | Vehicle |
|---------|-------------|---------|
| Courier | Small packages up to 5 kg | Motorcycle/Bicycle |
| Standard Parcel | 5–50 kg packages | Small/Medium Van |
| Bulk Freight | 50+ kg, pallets, large items | Large Truck |
| Cold Chain | Temperature-controlled cargo | Refrigerated Truck |
| Oversized Cargo | Heavy machinery, equipment | Flatbed/Special |
| Express Same-Day | Guaranteed same-day delivery | Any available |

### Customer Journey (Freight)
```
1. Customer/Business creates delivery order
2. Enters: pickup address, dropoff address, cargo details (weight, dimensions, value)
3. Selects service type (standard / cold chain / express)
4. Optionally adds cargo insurance (1.5% of declared value)
5. AI LoadOptimizer suggests optimal vehicle
6. Pricing calculated (base + per km + per kg + surcharges)
7. Driver assigned by AI DispatchBrain
8. Driver picks up cargo → scans OTP to confirm pickup
9. Real-time tracking link sent to recipient
10. Driver delivers → recipient scans OTP to confirm
11. Digital signature + delivery photo captured
12. Invoice generated automatically for corporate clients
```

### Cold Chain Sub-Service
```
Special Workflow:
• Customer specifies temperature range (e.g., 2°C – 4°C)
• Only refrigerated vehicles assigned
• IoT sensors in vehicle read temperature every 15 min
• Alert if temp goes out of range:
  → Notify driver immediately
  → Notify customer
  → Escalate to ops team if not resolved in 10 min
• Full temperature log delivered with shipment
• Cold chain premium: +35% on base price
```

### Freight Pricing Model
- Base fare: $5.00
- Per km: $2.00
- Per kg: $0.05
- Per m³: $2.00
- Cold chain surcharge: +35%
- Express same-day surcharge: +50%
- Cargo insurance: 1.5% of declared value
- Oversized surcharge: +25%
- Platform commission: 15-20%

### Key AI Modules Used
- LoadOptimizer → 3D bin-packing, maximize vehicle utilization
- RouteIntelligence → Multi-stop route optimization
- ETA Prophet → "Package arrives between 2pm–4pm"
- DemandOracle → Predict when cold chain vehicles will be needed
- SafetyShield → Cargo seal tampering, route deviation
- NexusChat → Support: "My package temperature alert triggered"

### Corporate B2B Features (Freight Only)
- Dedicated corporate dashboard
- Monthly consolidated invoicing
- Bulk booking API (e-commerce integration)
- Guaranteed capacity SLA
- Custom pricing contracts
- Priority dispatch queue
- Dedicated account manager

### Dashboard Color: Amber Orange (#FF9500)

---

## 🔗 SHARED INFRASTRUCTURE (Both Divisions)

```
┌────────────────────────────────────────────────────────────┐
│                    NEXUS LOGISTICS GROUP                    │
├─────────────────────────┬──────────────────────────────────┤
│     NEXUS RIDE          │        NEXUS FREIGHT              │
│     (Taxi)              │        (Logistics)                │
│  ● Standard Ride        │  ● Courier                        │
│  ● Premium              │  ● Standard Parcel                │
│  ● SUV                  │  ● Bulk Freight                   │
│  ● Pool/Share           │  ● Cold Chain ❄️                  │
│  ● Medical              │  ● Oversized Cargo                │
│  ● Airport              │  ● Express Same-Day               │
├─────────────────────────┴──────────────────────────────────┤
│                    NEXUS CORE AI                            │
│  DispatchBrain · ETA Prophet · PricingEngine               │
│  SafetyShield · FraudSentinel · DemandOracle               │
│  LoadOptimizer · NexusChat · RouteIntelligence             │
├────────────────────────────────────────────────────────────┤
│              SHARED INFRASTRUCTURE                          │
│  PostgreSQL + TimescaleDB · Redis · Kafka · Socket.io      │
│  Stripe Payments · Mapbox Routing · AWS S3                  │
│  Node.js API · Python AI Engine · Docker + K8s            │
└────────────────────────────────────────────────────────────┘
```

---

## 📊 SEPARATE DATABASE TABLES PER DIVISION

### RIDE Tables
- `trips` — All ride bookings
- `trip_ratings` — Passenger ↔ Driver ratings
- `surge_multipliers` — Zone-based surge (rides)

### FREIGHT Tables
- `deliveries` — All delivery orders
- `cargo_temperature_logs` — IoT cold chain readings (TimescaleDB)
- `cargo_seals` — Tamper detection events
- `driver_locations` — Real-time GPS (shared, tagged by service_type)

### SHARED Tables
- `users` — Customers (both divisions)
- `drivers` — All drivers (with `service_types[]` array e.g. `{taxi, freight, cold_chain}`)
- `vehicles` — All vehicles (type determines eligibility)
- `payments` — All transactions
- `pricing_zones` — Fare zones (separate fares for ride vs freight)
- `ai_decisions` — All AI decisions logged

---

## 📱 SEPARATE CUSTOMER-FACING APPS

### NEXUS RIDE App (Customer)
- Book taxi in 3 taps
- Real-time driver tracking on map
- Fare estimator with surge indicator
- Trip sharing (send live link to friend)
- Schedule future rides
- Ride history & receipts

### NEXUS FREIGHT App / Portal (Business)
- Create delivery order with cargo details
- Upload cargo photos
- Insurance add-on option
- Live tracking link for recipient
- Temperature monitoring dashboard (cold chain)
- Corporate account billing
- API for e-commerce integration (Shopify, WooCommerce)

### NEXUS DRIVER App (Combined)
- Drivers can toggle: "I'm available for Rides / Freight / Both"
- Different UI modes based on active service type
- Ride mode: navigation to pickup + dropoff
- Freight mode: warehouse pickup → OTP scan → delivery → OTP scan → photo

---

## 💰 REVENUE COMPARISON

| Metric | NEXUS RIDE | NEXUS FREIGHT |
|--------|-----------|---------------|
| Avg fare per transaction | $18–45 | $65–520 |
| Platform commission | 18–22% | 15–20% |
| Avg daily transactions | 800–2,000 | 50–200 |
| Revenue per driver/day | $180–320 | $300–600 |
| B2B potential | Low | Very High |
| Repeat frequency | High (daily) | High (weekly) |
| Seasonal variation | Low | Moderate |
| Cold chain premium | N/A | +35% |

---

*Both divisions. One AI brain. Zero compromise.*
*NEXUS LOGISTICS GROUP*
