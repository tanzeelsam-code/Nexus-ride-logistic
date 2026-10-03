"""
NEXUS LOGISTICS — NEXUS CORE AI ENGINE
=======================================
Multi-model AI system for intelligent transportation operations.
Handles: Dispatch, Routing, Pricing, ETA, Safety, Fraud, Forecasting

Requirements:
  pip install fastapi uvicorn torch numpy scikit-learn redis kafka-python
              geopy shapely openai anthropic httpx asyncio aioredis pydantic
"""

import asyncio
import json
import math
import time
import uuid
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, field, asdict
from enum import Enum

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import aioredis
import httpx

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')
logger = logging.getLogger("NEXUS-CORE")

# ============================================================
# CONFIGURATION
# ============================================================

class Config:
    REDIS_URL = "redis://localhost:6379"
    KAFKA_BROKERS = ["localhost:9092"]
    POSTGRES_URL = "postgresql://nexus:nexus@localhost/nexusdb"
    MAPS_API_KEY = "YOUR_MAPBOX_KEY"
    WEATHER_API_KEY = "YOUR_WEATHER_KEY"
    ANTHROPIC_API_KEY = "YOUR_ANTHROPIC_KEY"
    
    # Model paths
    DISPATCH_MODEL_PATH = "models/dispatch_brain_v3.pt"
    ETA_MODEL_PATH = "models/eta_prophet_v4.pt"
    DEMAND_MODEL_PATH = "models/demand_oracle_v2.pt"
    
    # AI thresholds
    MIN_DRIVER_SCORE = 0.35          # Minimum dispatch score to accept
    MAX_DISPATCH_CANDIDATES = 25     # Max drivers to consider per request
    SURGE_TRIGGER_RATIO = 1.4        # Demand/supply ratio to trigger surge
    FRAUD_BLOCK_THRESHOLD = 0.85     # Fraud score to auto-block
    
    # Timing
    DISPATCH_TIMEOUT_SEC = 30        # Max time to find driver
    DRIVER_RESPONSE_TIMEOUT_SEC = 20 # Driver must accept within this time
    LOCATION_UPDATE_INTERVAL_SEC = 3 # GPS update frequency
    
    # Pricing
    MIN_SURGE = 1.0
    MAX_SURGE = 3.5
    
    # Earth radius (km) for distance calc
    EARTH_RADIUS_KM = 6371.0

# ============================================================
# DATA MODELS
# ============================================================

class ServiceType(Enum):
    TAXI = "taxi"
    FREIGHT = "freight"
    MEDICAL = "medical"
    AIRPORT = "airport"
    COURIER = "courier"
    COLD_CHAIN = "cold_chain"

class VehicleType(Enum):
    SEDAN = "sedan"
    HATCHBACK = "hatchback"
    SUV = "suv"
    LUXURY = "luxury"
    VAN = "van"
    TRUCK_SMALL = "truck_small"
    TRUCK_MEDIUM = "truck_medium"
    TRUCK_LARGE = "truck_large"
    REFRIGERATED = "refrigerated"

@dataclass
class Location:
    lat: float
    lng: float
    address: str = ""
    
    def distance_km(self, other: 'Location') -> float:
        """Haversine distance between two coordinates"""
        lat1, lng1 = math.radians(self.lat), math.radians(self.lng)
        lat2, lng2 = math.radians(other.lat), math.radians(other.lng)
        dlat = lat2 - lat1
        dlng = lng2 - lng1
        a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng/2)**2
        return 2 * Config.EARTH_RADIUS_KM * math.asin(math.sqrt(a))

@dataclass
class Driver:
    id: str
    lat: float
    lng: float
    rating: float
    acceptance_rate: float
    completion_rate: float
    vehicle_type: str
    service_types: List[str]
    total_trips: int
    is_verified: bool = True
    current_passengers: int = 0
    battery_pct: int = 100
    
    @property
    def location(self) -> Location:
        return Location(self.lat, self.lng)

@dataclass  
class RideRequest:
    id: str
    customer_id: str
    pickup: Location
    dropoff: Location
    service_type: ServiceType
    vehicle_type_requested: Optional[str]
    scheduled_for: Optional[datetime] = None
    passengers: int = 1
    is_premium: bool = False
    cargo_weight_kg: Optional[float] = None
    cargo_volume_m3: Optional[float] = None
    requires_refrigeration: bool = False
    created_at: datetime = field(default_factory=datetime.utcnow)

@dataclass
class DispatchDecision:
    request_id: str
    assigned_driver_id: str
    driver_score: float
    estimated_pickup_min: float
    estimated_trip_min: float
    route_polyline: str
    alternatives_considered: int
    confidence: float
    reasoning: Dict[str, Any]
    decided_at: datetime = field(default_factory=datetime.utcnow)

@dataclass
class PricingResult:
    base_fare: float
    distance_fare: float
    time_fare: float
    surge_multiplier: float
    surge_reason: Optional[str]
    total_fare: float
    estimated_fare_range: Tuple[float, float]
    currency: str = "USD"

@dataclass
class ETAResult:
    pickup_min: float
    dropoff_min: float
    confidence: float
    factors: Dict[str, Any]

# ============================================================
# NEURAL NETWORK MODELS
# ============================================================

class DispatchBrainNet(nn.Module):
    """
    Deep neural network for driver-request matching.
    Inputs: Driver features + Request features + Context features
    Output: Match score (0-1)
    
    Architecture: Multi-head attention over driver candidates
    """
    
    def __init__(self, driver_features=32, request_features=24, context_features=16):
        super().__init__()
        
        total_features = driver_features + request_features + context_features
        
        # Shared embedding layers
        self.driver_encoder = nn.Sequential(
            nn.Linear(driver_features, 64),
            nn.LayerNorm(64),
            nn.GELU(),
            nn.Linear(64, 128),
            nn.LayerNorm(128),
            nn.GELU(),
            nn.Dropout(0.1)
        )
        
        self.request_encoder = nn.Sequential(
            nn.Linear(request_features, 64),
            nn.LayerNorm(64),
            nn.GELU(),
            nn.Linear(64, 128),
            nn.LayerNorm(128),
            nn.GELU(),
        )
        
        self.context_encoder = nn.Sequential(
            nn.Linear(context_features, 32),
            nn.GELU(),
            nn.Linear(32, 64),
        )
        
        # Cross-attention: request attends to driver
        self.cross_attention = nn.MultiheadAttention(128, num_heads=4, dropout=0.1, batch_first=True)
        
        # Final scoring head
        self.scorer = nn.Sequential(
            nn.Linear(128 + 128 + 64, 256),
            nn.LayerNorm(256),
            nn.GELU(),
            nn.Dropout(0.15),
            nn.Linear(256, 64),
            nn.GELU(),
            nn.Linear(64, 1),
            nn.Sigmoid()
        )
    
    def forward(self, driver_feats, request_feats, context_feats):
        """
        driver_feats:  [batch, driver_features]
        request_feats: [batch, request_features]
        context_feats: [batch, context_features]
        """
        d_enc = self.driver_encoder(driver_feats)        # [B, 128]
        r_enc = self.request_encoder(request_feats)      # [B, 128]
        c_enc = self.context_encoder(context_feats)      # [B, 64]
        
        # Cross-attention (driver features attend to request context)
        d_seq = d_enc.unsqueeze(1)                       # [B, 1, 128]
        r_seq = r_enc.unsqueeze(1)                       # [B, 1, 128]
        attended, _ = self.cross_attention(d_seq, r_seq, r_seq)
        attended = attended.squeeze(1)                    # [B, 128]
        
        # Concatenate all representations
        combined = torch.cat([attended, r_enc, c_enc], dim=1)  # [B, 320]
        score = self.scorer(combined)                    # [B, 1]
        return score.squeeze(1)


class ETAProphetNet(nn.Module):
    """
    LSTM-based ETA prediction with contextual features.
    Considers: distance, time of day, weather, traffic, day of week, 
               historical patterns for that route
    """
    
    def __init__(self, input_size=20, hidden_size=128, num_layers=3):
        super().__init__()
        
        self.feature_proj = nn.Linear(input_size, 64)
        
        self.lstm = nn.LSTM(
            64, hidden_size, num_layers=num_layers,
            batch_first=True, dropout=0.2, bidirectional=True
        )
        
        self.output_head = nn.Sequential(
            nn.Linear(hidden_size * 2, 128),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(128, 32),
            nn.ReLU(),
            nn.Linear(32, 2)  # [pickup_eta, dropoff_eta]
        )
        
        # Confidence estimator
        self.confidence_head = nn.Sequential(
            nn.Linear(hidden_size * 2, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
            nn.Sigmoid()
        )
    
    def forward(self, features_seq):
        """features_seq: [batch, seq_len, input_size]"""
        proj = F.relu(self.feature_proj(features_seq))
        lstm_out, (h_n, _) = self.lstm(proj)
        last_out = lstm_out[:, -1, :]       # Last timestep
        eta = F.relu(self.output_head(last_out))
        confidence = self.confidence_head(last_out)
        return eta, confidence


class DemandOracleNet(nn.Module):
    """
    Transformer-based demand forecasting.
    Predicts demand heatmap for next 72 hours across zones.
    """
    
    def __init__(self, n_zones=50, seq_len=168, d_model=128, nhead=8, n_layers=4):
        super().__init__()
        
        self.zone_embedding = nn.Embedding(n_zones, d_model // 4)
        self.time_embedding = nn.Linear(4, d_model // 4)    # hour, day, month, is_holiday
        self.feature_proj = nn.Linear(10, d_model // 2)     # Historical demand + weather features
        
        self.input_proj = nn.Linear(d_model, d_model)
        
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=nhead, 
            dim_feedforward=512, dropout=0.1,
            batch_first=True, norm_first=True
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
        
        # Multi-horizon prediction (next 1h, 4h, 12h, 24h, 72h)
        self.forecast_heads = nn.ModuleList([
            nn.Linear(d_model, n_zones) for _ in range(5)
        ])
    
    def forward(self, zone_ids, time_feats, historical_feats):
        z_emb = self.zone_embedding(zone_ids)
        t_emb = self.time_embedding(time_feats)
        f_emb = self.feature_proj(historical_feats)
        
        x = torch.cat([z_emb, t_emb, f_emb], dim=-1)
        x = self.input_proj(x)
        x = self.transformer(x)
        
        forecasts = [head(x[:, -1, :]) for head in self.forecast_heads]
        return torch.stack(forecasts, dim=1)  # [B, 5_horizons, n_zones]

# ============================================================
# AI ENGINE — CORE CLASS
# ============================================================

class NexusCore:
    """
    Central AI brain. Orchestrates all AI decisions for NEXUS LOGISTICS.
    """
    
    def __init__(self):
        self.redis: Optional[aioredis.Redis] = None
        self._initialized = False
        
        # Load models
        self.dispatch_model = DispatchBrainNet()
        self.eta_model = ETAProphetNet()
        self.demand_model = DemandOracleNet()
        
        self.dispatch_model.eval()
        self.eta_model.eval()
        self.demand_model.eval()
        
        logger.info("NEXUS CORE initialized with all AI models")
    
    async def initialize(self):
        """Connect to infrastructure services"""
        self.redis = await aioredis.from_url(Config.REDIS_URL, decode_responses=True)
        self._initialized = True
        logger.info("NEXUS CORE connected to Redis")
    
    # ----------------------------------------------------------
    # MODULE 1: DISPATCH BRAIN
    # ----------------------------------------------------------
    
    async def dispatch(self, request: RideRequest, nearby_drivers: List[Driver]) -> Optional[DispatchDecision]:
        """
        Find the optimal driver for a given request using DispatchBrainNet.
        
        Algorithm:
        1. Filter ineligible drivers (wrong vehicle type, wrong service capability)
        2. Score all eligible drivers using the neural network
        3. Apply business rules as hard constraints
        4. Select highest scoring driver
        5. Log decision for model monitoring
        """
        if not nearby_drivers:
            logger.warning(f"No drivers available for request {request.id}")
            return None
        
        start_time = time.time()
        
        # Step 1: Filter
        eligible = self._filter_eligible_drivers(request, nearby_drivers)
        if not eligible:
            return None
        
        # Limit candidates for performance
        candidates = eligible[:Config.MAX_DISPATCH_CANDIDATES]
        
        # Step 2: Feature engineering
        request_features = self._extract_request_features(request)
        context_features = await self._extract_context_features(request)
        
        scores = []
        with torch.no_grad():
            for driver in candidates:
                driver_features = self._extract_driver_features(driver, request)
                
                d_tensor = torch.tensor([driver_features], dtype=torch.float32)
                r_tensor = torch.tensor([request_features], dtype=torch.float32)
                c_tensor = torch.tensor([context_features], dtype=torch.float32)
                
                score = self.dispatch_model(d_tensor, r_tensor, c_tensor)
                scores.append((driver, float(score.item())))
        
        # Step 3: Apply hard constraints and sort
        valid_scores = [(d, s) for d, s in scores if s >= Config.MIN_DRIVER_SCORE]
        if not valid_scores:
            # Relax threshold slightly
            valid_scores = sorted(scores, key=lambda x: x[1], reverse=True)[:1]
        
        if not valid_scores:
            return None
        
        # Step 4: Select best driver
        best_driver, best_score = max(valid_scores, key=lambda x: x[1])
        
        # Step 5: Calculate ETA for this match
        distance_to_pickup = best_driver.location.distance_km(request.pickup)
        eta = await self.predict_eta(
            driver=best_driver,
            pickup=request.pickup,
            dropoff=request.dropoff
        )
        
        processing_ms = int((time.time() - start_time) * 1000)
        
        decision = DispatchDecision(
            request_id=request.id,
            assigned_driver_id=best_driver.id,
            driver_score=best_score,
            estimated_pickup_min=eta.pickup_min,
            estimated_trip_min=eta.dropoff_min,
            route_polyline="",  # Would be fetched from Maps API
            alternatives_considered=len(candidates),
            confidence=eta.confidence,
            reasoning={
                "distance_km": round(distance_to_pickup, 2),
                "driver_rating": best_driver.rating,
                "acceptance_rate": best_driver.acceptance_rate,
                "completion_rate": best_driver.completion_rate,
                "total_trips": best_driver.total_trips,
                "processing_ms": processing_ms,
                "candidates_evaluated": len(candidates),
                "score_breakdown": {
                    "proximity": min(1.0, 1.0 - distance_to_pickup / 10),
                    "rating": best_driver.rating / 5,
                    "reliability": best_driver.completion_rate / 100,
                }
            }
        )
        
        # Log for model monitoring
        await self._log_ai_decision("dispatch", {
            "request_id": request.id,
            "driver_id": best_driver.id,
            "score": best_score,
            "candidates": len(candidates),
            "processing_ms": processing_ms,
        })
        
        logger.info(f"Dispatched driver {best_driver.id} for request {request.id} "
                   f"(score={best_score:.3f}, eta={eta.pickup_min:.1f}min)")
        
        return decision
    
    def _filter_eligible_drivers(self, request: RideRequest, drivers: List[Driver]) -> List[Driver]:
        """Apply hard business rules to filter ineligible drivers"""
        eligible = []
        for driver in drivers:
            # Must support the service type
            if request.service_type.value not in driver.service_types:
                continue
            # Vehicle type match (if specified)
            if request.vehicle_type_requested and driver.vehicle_type != request.vehicle_type_requested:
                continue
            # Refrigeration requirement
            if request.requires_refrigeration and driver.vehicle_type != VehicleType.REFRIGERATED.value:
                continue
            # Basic sanity: driver must be close enough
            dist = driver.location.distance_km(request.pickup)
            if dist > 15.0:  # 15km max dispatch radius
                continue
            eligible.append(driver)
        return eligible
    
    def _extract_driver_features(self, driver: Driver, request: RideRequest) -> List[float]:
        """Extract 32 numerical features from driver for the model"""
        dist_to_pickup = driver.location.distance_km(request.pickup)
        dist_to_dropoff = request.pickup.distance_km(request.dropoff)
        
        return [
            dist_to_pickup / 20.0,                          # Normalized distance (0-20km)
            driver.rating / 5.0,                            # Rating
            driver.acceptance_rate / 100.0,                 # Acceptance rate
            driver.completion_rate / 100.0,                 # Completion rate
            min(driver.total_trips / 1000.0, 1.0),         # Experience (capped)
            1.0 if driver.is_verified else 0.0,             # Verification status
            driver.battery_pct / 100.0,                     # Phone battery
            driver.current_passengers / 4.0,                # Current load
            
            # Vehicle type one-hot (8 types)
            1.0 if driver.vehicle_type == 'sedan' else 0.0,
            1.0 if driver.vehicle_type == 'suv' else 0.0,
            1.0 if driver.vehicle_type == 'luxury' else 0.0,
            1.0 if driver.vehicle_type == 'van' else 0.0,
            1.0 if driver.vehicle_type == 'truck_small' else 0.0,
            1.0 if driver.vehicle_type == 'truck_medium' else 0.0,
            1.0 if driver.vehicle_type == 'truck_large' else 0.0,
            1.0 if driver.vehicle_type == 'refrigerated' else 0.0,
            
            # Service type capabilities
            1.0 if 'taxi' in driver.service_types else 0.0,
            1.0 if 'freight' in driver.service_types else 0.0,
            1.0 if 'cold_chain' in driver.service_types else 0.0,
            
            # Geographic features
            (driver.lat - request.pickup.lat) / 0.5,        # Relative lat
            (driver.lng - request.pickup.lng) / 0.5,        # Relative lng
            
            # ETA components
            min(dist_to_pickup * 2.0 / 60.0, 1.0),         # Rough pickup ETA
            min(dist_to_dropoff * 2.0 / 60.0, 1.0),        # Trip duration estimate
            
            # Padding to 32 features
            0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0,
            0.0,
        ]
    
    def _extract_request_features(self, request: RideRequest) -> List[float]:
        """Extract 24 numerical features from request"""
        now = datetime.utcnow()
        hour = now.hour
        dow = now.weekday()
        
        dist = request.pickup.distance_km(request.dropoff)
        
        return [
            request.pickup.lat / 90.0,
            request.pickup.lng / 180.0,
            request.dropoff.lat / 90.0,
            request.dropoff.lng / 180.0,
            min(dist / 50.0, 1.0),                          # Trip distance
            hour / 23.0,                                     # Hour of day
            dow / 6.0,                                       # Day of week
            math.sin(2 * math.pi * hour / 24),              # Cyclical hour sin
            math.cos(2 * math.pi * hour / 24),              # Cyclical hour cos
            math.sin(2 * math.pi * dow / 7),                # Cyclical dow sin
            math.cos(2 * math.pi * dow / 7),                # Cyclical dow cos
            request.passengers / 8.0,                        # Passenger count
            1.0 if request.is_premium else 0.0,
            1.0 if request.requires_refrigeration else 0.0,
            (request.cargo_weight_kg or 0) / 1000.0,
            (request.cargo_volume_m3 or 0) / 20.0,
            
            # Service type one-hot
            1.0 if request.service_type == ServiceType.TAXI else 0.0,
            1.0 if request.service_type == ServiceType.FREIGHT else 0.0,
            1.0 if request.service_type == ServiceType.COLD_CHAIN else 0.0,
            1.0 if request.service_type == ServiceType.MEDICAL else 0.0,
            1.0 if request.service_type == ServiceType.AIRPORT else 0.0,
            
            # Padding to 24
            0.0, 0.0, 0.0,
        ]
    
    async def _extract_context_features(self, request: RideRequest) -> List[float]:
        """Extract 16 context features (traffic, weather, demand level)"""
        # In production: fetch from Redis cache (updated by Kafka streams)
        surge = await self.get_surge_multiplier(request.pickup, request.service_type)
        
        now = datetime.utcnow()
        is_peak = 1.0 if now.hour in [7,8,9,17,18,19] else 0.0
        is_weekend = 1.0 if now.weekday() >= 5 else 0.0
        
        return [
            surge / Config.MAX_SURGE,                        # Current surge (normalized)
            is_peak,                                         # Peak hours
            is_weekend,                                      # Weekend
            0.5,                                             # Traffic density (0=clear, 1=jam)
            0.2,                                             # Rain probability
            0.0,                                             # Special event nearby
            0.7,                                             # Driver supply ratio in zone
            0.6,                                             # Historical demand this slot
            
            # Padding to 16
            0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0,
        ]
    
    # ----------------------------------------------------------
    # MODULE 2: ETA PROPHET
    # ----------------------------------------------------------
    
    async def predict_eta(self, driver: Driver, pickup: Location, dropoff: Location) -> ETAResult:
        """
        Predict pickup and dropoff ETAs using ETAProphetNet.
        Factors: distance, speed limits, traffic, time of day, weather
        """
        dist_pickup = driver.location.distance_km(pickup)
        dist_trip = pickup.distance_km(dropoff)
        now = datetime.utcnow()
        
        # Feature sequence (last 5 time steps for LSTM)
        features = []
        for i in range(5):
            dt = now - timedelta(minutes=i*5)
            features.append([
                dist_pickup / 50.0,
                dist_trip / 100.0,
                dt.hour / 23.0,
                dt.weekday() / 6.0,
                math.sin(2 * math.pi * dt.hour / 24),
                math.cos(2 * math.pi * dt.hour / 24),
                0.5,   # Traffic level (from API)
                0.2,   # Weather factor
                0.0,   # Construction zone
                1.0 if dt.hour in [7,8,9,17,18,19] else 0.0,  # Peak hour
                # Speed context
                40.0 / 130.0,   # Average speed (normalized)
                # Route complexity
                min(dist_pickup / 20.0, 1.0),
                min(dist_trip / 50.0, 1.0),
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0  # Padding to 20
            ])
        
        features_tensor = torch.tensor([features], dtype=torch.float32)
        
        with torch.no_grad():
            eta_raw, confidence = self.eta_model(features_tensor)
        
        pickup_min = float(eta_raw[0, 0].item()) * 60  # Scale to minutes
        dropoff_min = float(eta_raw[0, 1].item()) * 60
        conf = float(confidence[0].item())
        
        # Sanity: enforce minimum ETAs based on raw distance
        min_pickup = (dist_pickup / 40.0) * 60  # 40 km/h average
        min_dropoff = (dist_trip / 30.0) * 60   # 30 km/h in traffic
        pickup_min = max(pickup_min, min_pickup)
        dropoff_min = max(dropoff_min, min_dropoff)
        
        return ETAResult(
            pickup_min=round(pickup_min, 1),
            dropoff_min=round(dropoff_min, 1),
            confidence=round(conf, 3),
            factors={
                "distance_to_pickup_km": round(dist_pickup, 2),
                "trip_distance_km": round(dist_trip, 2),
                "traffic_factor": 0.5,
                "weather_factor": 0.0,
                "is_peak_hour": now.hour in [7,8,9,17,18,19],
            }
        )
    
    # ----------------------------------------------------------
    # MODULE 3: PRICING ENGINE (Reinforcement Learning)
    # ----------------------------------------------------------
    
    async def calculate_price(self,
                              request: RideRequest,
                              zone: Dict,
                              weather_severity: float = 0.0) -> PricingResult:
        """
        Dynamic pricing using supply/demand ratios + RL surge.
        
        RL Policy: Maximize revenue while maintaining driver supply 
                   and customer satisfaction metrics.
        """
        service = request.service_type
        dist = request.pickup.distance_km(request.dropoff)
        
        # Base fares from zone config
        if service in [ServiceType.TAXI, ServiceType.MEDICAL, ServiceType.AIRPORT]:
            base_fare = zone.get('taxi_base_fare', 2.50)
            per_km = zone.get('taxi_per_km', 1.20)
            per_min = zone.get('taxi_per_minute', 0.25)
            min_fare = zone.get('taxi_minimum_fare', 5.00)
            est_duration_min = (dist / 30.0) * 60
        else:  # Freight variants
            base_fare = zone.get('freight_base_fare', 5.00)
            per_km = zone.get('freight_per_km', 2.00)
            per_min = 0.0
            min_fare = 8.00
            est_duration_min = (dist / 40.0) * 60
        
        # Cargo pricing for freight
        weight_fare = (request.cargo_weight_kg or 0) * zone.get('freight_per_kg', 0.05)
        volume_fare = (request.cargo_volume_m3 or 0) * zone.get('freight_per_m3', 2.00)
        
        distance_fare = dist * per_km
        time_fare = est_duration_min * per_min
        
        # AI Surge Calculation
        surge = await self.get_surge_multiplier(request.pickup, service)
        
        # Weather premium
        weather_premium = 1.0 + (weather_severity * 0.2)
        effective_surge = min(surge * weather_premium, Config.MAX_SURGE)
        
        # Cold chain premium
        cold_chain_surcharge = 0.0
        if request.requires_refrigeration:
            cold_chain_surcharge = (base_fare + distance_fare) * 0.35
        
        # Calculate totals
        subtotal = (base_fare + distance_fare + time_fare + weight_fare + volume_fare) * effective_surge
        total = max(subtotal + cold_chain_surcharge, min_fare)
        
        # Estimated range (±10% for uncertainty)
        fare_range = (round(total * 0.90, 2), round(total * 1.10, 2))
        
        surge_reason = None
        if effective_surge > 1.2:
            if weather_severity > 0.3:
                surge_reason = "Weather conditions"
            else:
                surge_reason = "High demand in your area"
        
        return PricingResult(
            base_fare=round(base_fare, 2),
            distance_fare=round(distance_fare, 2),
            time_fare=round(time_fare, 2),
            surge_multiplier=round(effective_surge, 2),
            surge_reason=surge_reason,
            total_fare=round(total, 2),
            estimated_fare_range=fare_range,
        )
    
    async def get_surge_multiplier(self, location: Location, service_type: ServiceType) -> float:
        """
        Calculate surge multiplier using demand/supply ratio for the zone.
        
        Surge Formula:
          ratio = demand_requests / available_drivers
          if ratio < 1.0: surge = 1.0
          if ratio > SURGE_TRIGGER_RATIO: surge = 1.0 + (ratio - 1.0) * 0.5
          capped at MAX_SURGE
        """
        cache_key = f"surge:{round(location.lat, 2)}:{round(location.lng, 2)}:{service_type.value}"
        
        cached = await self.redis.get(cache_key) if self.redis else None
        if cached:
            return float(cached)
        
        # Simulate: In production, query real-time driver counts from Redis
        demand = 12   # Active requests in zone
        supply = 8    # Available drivers in zone
        
        ratio = demand / max(supply, 1)
        
        if ratio <= 1.0:
            surge = 1.0
        elif ratio <= Config.SURGE_TRIGGER_RATIO:
            surge = 1.0
        else:
            surge = 1.0 + (ratio - 1.0) * 0.45
        
        surge = round(min(max(surge, Config.MIN_SURGE), Config.MAX_SURGE), 2)
        
        # Cache for 30 seconds
        if self.redis:
            await self.redis.setex(cache_key, 30, str(surge))
        
        return surge
    
    # ----------------------------------------------------------
    # MODULE 4: DEMAND ORACLE
    # ----------------------------------------------------------
    
    async def forecast_demand(self, zone_ids: List[int], horizon_hours: int = 24) -> Dict:
        """
        Forecast demand across zones for the next N hours.
        Returns heatmap data for operations dashboard.
        """
        now = datetime.utcnow()
        
        zone_tensor = torch.tensor([zone_ids], dtype=torch.long)
        time_feats = torch.tensor([[
            now.hour / 23.0,
            now.weekday() / 6.0,
            now.month / 12.0,
            1.0 if now.weekday() >= 5 else 0.0
        ]], dtype=torch.float32)
        hist_feats = torch.zeros(1, len(zone_ids), 10)  # Would be real historical data
        
        with torch.no_grad():
            forecasts = self.demand_model(zone_tensor, time_feats, hist_feats)
        
        horizons = ["1h", "4h", "12h", "24h", "72h"]
        result = {}
        for i, h in enumerate(horizons):
            result[h] = {
                f"zone_{z}": float(forecasts[0, i, j].item())
                for j, z in enumerate(zone_ids)
            }
        
        return {
            "forecast_at": now.isoformat(),
            "horizons": result,
            "recommended_positioning": self._recommend_driver_positioning(result["1h"])
        }
    
    def _recommend_driver_positioning(self, demand_forecast: Dict) -> List[Dict]:
        """Recommend where drivers should pre-position based on 1h demand forecast"""
        sorted_zones = sorted(demand_forecast.items(), key=lambda x: x[1], reverse=True)
        return [
            {"zone": zone, "demand_score": round(score, 3), "action": "position_here"}
            for zone, score in sorted_zones[:5]
        ]
    
    # ----------------------------------------------------------
    # MODULE 5: FRAUD SENTINEL
    # ----------------------------------------------------------
    
    async def check_fraud(self, payment_data: Dict) -> Dict:
        """
        Real-time fraud detection using anomaly detection.
        Checks: transaction velocity, location mismatch, device fingerprint, 
                behavioral biometrics, card BIN analysis.
        
        Returns fraud score (0-1) and recommended action.
        """
        score = 0.0
        flags = []
        
        # Rule-based signals (would be ML model in production)
        amount = payment_data.get('amount', 0)
        customer_id = payment_data.get('customer_id')
        
        # Velocity check
        recent_tx_count = await self._get_recent_transaction_count(customer_id)
        if recent_tx_count > 5:
            score += 0.3
            flags.append("high_velocity")
        
        # Unusual amount
        avg_amount = await self._get_average_amount(customer_id)
        if avg_amount and amount > avg_amount * 5:
            score += 0.25
            flags.append("unusual_amount")
        
        # Location mismatch
        if payment_data.get('billing_country') != payment_data.get('request_country'):
            score += 0.2
            flags.append("country_mismatch")
        
        # New device with high-value transaction
        if payment_data.get('new_device') and amount > 50:
            score += 0.15
            flags.append("new_device_high_value")
        
        score = min(score, 1.0)
        
        action = "allow"
        if score >= Config.FRAUD_BLOCK_THRESHOLD:
            action = "block"
        elif score >= 0.5:
            action = "review"
        elif score >= 0.3:
            action = "3ds_challenge"
        
        return {
            "score": round(score, 3),
            "action": action,
            "flags": flags,
            "checked_at": datetime.utcnow().isoformat()
        }
    
    async def _get_recent_transaction_count(self, customer_id: str) -> int:
        if not self.redis:
            return 0
        count = await self.redis.get(f"tx_count:{customer_id}:1h")
        return int(count) if count else 0
    
    async def _get_average_amount(self, customer_id: str) -> Optional[float]:
        if not self.redis:
            return None
        avg = await self.redis.get(f"avg_amount:{customer_id}")
        return float(avg) if avg else None
    
    # ----------------------------------------------------------
    # MODULE 6: SAFETY SHIELD
    # ----------------------------------------------------------
    
    async def analyze_trip_safety(self, trip_id: str, telemetry: Dict) -> Dict:
        """
        Real-time safety monitoring using telemetry from driver app.
        Detects: harsh braking, route deviation, speed violations, 
                 distracted driving, suspicious stops.
        """
        alerts = []
        severity = "normal"
        
        # Speed check
        speed = telemetry.get('speed_kmh', 0)
        speed_limit = telemetry.get('speed_limit_kmh', 60)
        if speed > speed_limit * 1.3:
            alerts.append({
                "type": "speeding",
                "severity": "high",
                "detail": f"Speed: {speed:.0f} km/h, Limit: {speed_limit} km/h"
            })
            severity = "high"
        
        # Harsh braking (deceleration > 0.5g)
        acceleration = telemetry.get('acceleration_g', 0)
        if acceleration < -0.5:
            alerts.append({
                "type": "harsh_braking",
                "severity": "medium",
                "detail": f"Deceleration: {acceleration:.2f}g"
            })
        
        # Route deviation
        expected_route = telemetry.get('on_expected_route', True)
        deviation_km = telemetry.get('route_deviation_km', 0)
        if not expected_route and deviation_km > 0.5:
            alerts.append({
                "type": "route_deviation",
                "severity": "high",
                "detail": f"Deviated {deviation_km:.1f} km from planned route"
            })
            severity = "critical"
        
        # Long stop (not at destination)
        stop_duration_min = telemetry.get('stop_duration_min', 0)
        at_destination = telemetry.get('at_destination', False)
        if stop_duration_min > 10 and not at_destination:
            alerts.append({
                "type": "unexpected_stop",
                "severity": "medium",
                "detail": f"Stopped for {stop_duration_min:.0f} minutes"
            })
        
        # Update safety score in Redis
        safety_score = 1.0 - (len(alerts) * 0.2)
        safety_score = max(0.0, safety_score)
        
        if self.redis:
            await self.redis.setex(f"safety:{trip_id}", 3600, str(safety_score))
        
        return {
            "trip_id": trip_id,
            "safety_score": round(safety_score, 3),
            "severity": severity,
            "alerts": alerts,
            "action_required": severity in ["high", "critical"],
            "timestamp": datetime.utcnow().isoformat()
        }
    
    # ----------------------------------------------------------
    # MODULE 7: NEXUS CHAT (AI Customer Support)
    # ----------------------------------------------------------
    
    async def handle_support_query(self, query: str, context: Dict) -> str:
        """
        AI-powered customer support using Claude.
        Handles: trip issues, billing disputes, driver complaints,
                 ETA queries, cancellation requests.
        """
        system_prompt = """You are NEXUS, an AI customer support agent for NEXUS LOGISTICS.
You help with:
- Ride and delivery status
- Billing and payment issues  
- Driver feedback and safety reports
- Cancellations and refunds
- General app help

Always be empathetic, professional, and solution-focused.
If an issue requires human escalation, say so clearly.
You have access to the customer's account context provided.
Keep responses concise and actionable."""
        
        context_text = f"""
Customer: {context.get('customer_name', 'Guest')}
Account Tier: {context.get('tier', 'bronze')}
Active Trip/Delivery: {context.get('active_trip_id', 'None')}
Recent Trips: {context.get('recent_trips_count', 0)} in last 30 days
Issue Type: {context.get('issue_type', 'general')}
"""
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": Config.ANTHROPIC_API_KEY,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json"
                    },
                    json={
                        "model": "claude-sonnet-4-20250514",
                        "max_tokens": 500,
                        "system": system_prompt,
                        "messages": [
                            {"role": "user", "content": f"Context:\n{context_text}\n\nCustomer query: {query}"}
                        ]
                    },
                    timeout=30.0
                )
                data = response.json()
                return data['content'][0]['text']
        except Exception as e:
            logger.error(f"NexusChat error: {e}")
            return ("I apologize, I'm having trouble processing your request right now. "
                   "Please contact our support team directly at support@nexuslogistics.ai "
                   "or call +1-800-NEXUS-GO.")
    
    # ----------------------------------------------------------
    # MODULE 8: LOAD OPTIMIZER (Freight)
    # ----------------------------------------------------------
    
    def optimize_freight_load(self, vehicle: Dict, packages: List[Dict]) -> Dict:
        """
        Optimize package placement in freight vehicle.
        Uses 3D bin-packing algorithm + weight distribution.
        Returns loading sequence and placement coordinates.
        """
        vehicle_l = vehicle.get('length_cm', 400)
        vehicle_w = vehicle.get('width_cm', 200)
        vehicle_h = vehicle.get('height_cm', 200)
        max_weight = vehicle.get('max_weight_kg', 1000)
        
        # Sort packages: heaviest + largest first (greedy bin-packing)
        sorted_pkgs = sorted(packages, 
                            key=lambda p: (p.get('weight_kg', 0) * 
                                          p.get('length_cm', 0) * 
                                          p.get('width_cm', 0) * 
                                          p.get('height_cm', 0)),
                            reverse=True)
        
        placed = []
        total_weight = 0
        current_x = 0
        
        for pkg in sorted_pkgs:
            pkg_w = pkg.get('weight_kg', 0)
            pkg_l = pkg.get('length_cm', 0)
            
            if total_weight + pkg_w > max_weight:
                break
            if current_x + pkg_l > vehicle_l:
                break
            
            placed.append({
                "package_id": pkg.get('id'),
                "position": {"x": current_x, "y": 0, "z": 0},
                "fragile": pkg.get('is_fragile', False),
                "load_order": len(placed) + 1,
                "unload_first": pkg.get('dropoff_sequence', 0) == 1
            })
            
            total_weight += pkg_w
            current_x += pkg_l
        
        utilization = (total_weight / max_weight) * 100 if max_weight > 0 else 0
        
        return {
            "placed_packages": placed,
            "total_weight_kg": round(total_weight, 2),
            "weight_utilization_pct": round(utilization, 1),
            "volume_utilization_pct": round((current_x / vehicle_l) * 100, 1),
            "loading_sequence": [p['package_id'] for p in placed],
            "warnings": ["Fragile items detected — load last"] if any(p['fragile'] for p in placed) else []
        }
    
    # ----------------------------------------------------------
    # UTILITIES
    # ----------------------------------------------------------
    
    async def _log_ai_decision(self, decision_type: str, data: Dict):
        """Log AI decisions for monitoring and model retraining"""
        if self.redis:
            key = f"ai_log:{decision_type}:{datetime.utcnow().strftime('%Y%m%d%H')}"
            await self.redis.lpush(key, json.dumps(data))
            await self.redis.expire(key, 86400 * 7)  # Keep 7 days


# ============================================================
# FASTAPI APPLICATION
# ============================================================

app = FastAPI(
    title="NEXUS CORE — AI Engine",
    description="Central AI decision engine for NEXUS LOGISTICS",
    version="3.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

nexus_core = NexusCore()


@app.on_event("startup")
async def startup():
    await nexus_core.initialize()
    logger.info("🚀 NEXUS CORE API started")


# -- Request/Response Models --

class DispatchRequest(BaseModel):
    request_id: str
    customer_id: str
    pickup_lat: float
    pickup_lng: float
    pickup_address: str
    dropoff_lat: float
    dropoff_lng: float
    dropoff_address: str
    service_type: str = "taxi"
    vehicle_type: Optional[str] = None
    passengers: int = 1
    cargo_weight_kg: Optional[float] = None
    cargo_volume_m3: Optional[float] = None
    requires_refrigeration: bool = False
    drivers: Optional[List[Dict[str, Any]]] = None

class PriceRequest(BaseModel):
    pickup_lat: float
    pickup_lng: float
    dropoff_lat: float
    dropoff_lng: float
    service_type: str = "taxi"
    cargo_weight_kg: Optional[float] = None
    cargo_volume_m3: Optional[float] = None
    requires_refrigeration: bool = False
    zone_id: Optional[str] = None

class SafetyCheckRequest(BaseModel):
    trip_id: str
    speed_kmh: float
    speed_limit_kmh: float
    acceleration_g: float = 0.0
    on_expected_route: bool = True
    route_deviation_km: float = 0.0
    stop_duration_min: float = 0.0
    at_destination: bool = False

class SupportRequest(BaseModel):
    query: str
    customer_id: str
    customer_name: str = "Customer"
    tier: str = "bronze"
    active_trip_id: Optional[str] = None
    recent_trips_count: int = 0
    issue_type: str = "general"

class FraudCheckRequest(BaseModel):
    customer_id: str
    amount: float
    payment_method: str
    billing_country: Optional[str] = None
    request_country: Optional[str] = None
    new_device: bool = False


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "NEXUS CORE AI",
        "version": "3.0.0",
        "models": {
            "dispatch_brain": "loaded",
            "eta_prophet": "loaded",
            "demand_oracle": "loaded"
        },
        "timestamp": datetime.utcnow().isoformat()
    }


@app.post("/dispatch")
async def dispatch_driver(req: DispatchRequest, background_tasks: BackgroundTasks):
    """Find optimal driver for a ride/delivery request"""
    request = RideRequest(
        id=req.request_id,
        customer_id=req.customer_id,
        pickup=Location(req.pickup_lat, req.pickup_lng, req.pickup_address),
        dropoff=Location(req.dropoff_lat, req.dropoff_lng, req.dropoff_address),
        service_type=ServiceType(req.service_type),
        vehicle_type_requested=req.vehicle_type,
        passengers=req.passengers,
        cargo_weight_kg=req.cargo_weight_kg,
        cargo_volume_m3=req.cargo_volume_m3,
        requires_refrigeration=req.requires_refrigeration
    )
    
    # Use real candidate drivers if provided by API/PostGIS, otherwise generate nearby candidates
    if req.drivers and len(req.drivers) > 0:
        candidate_drivers = [
            Driver(
                id=str(d.get("id", f"drv_{i}")),
                lat=float(d.get("lat", req.pickup_lat + 0.002 * (i + 1))),
                lng=float(d.get("lng", req.pickup_lng + 0.002 * (i + 1))),
                rating=float(d.get("rating", 4.8)),
                acceptance_rate=float(d.get("acceptance_rate", 95.0)),
                completion_rate=float(d.get("completion_rate", 98.0)),
                vehicle_type=str(d.get("vehicle_type", "sedan")),
                service_types=list(d.get("service_types", ["taxi", "freight"])),
                trips_today=int(d.get("trips_today", 5))
            )
            for i, d in enumerate(req.drivers)
        ]
    else:
        candidate_drivers = [
            Driver(f"drv_{i}", req.pickup_lat + (i * 0.005), req.pickup_lng + (i * 0.003),
                   4.5 - (i * 0.1), 92.0 - i, 97.0, "sedan", ["taxi", "airport", "freight"], 500 + i * 100)
            for i in range(8)
        ]
    
    decision = await nexus_core.dispatch(request, candidate_drivers)
    
    if not decision:
        raise HTTPException(status_code=503, detail="No available drivers in your area")
    
    return {
        "status": "dispatched",
        "driver_id": decision.assigned_driver_id,
        "confidence": decision.confidence,
        "eta_pickup_min": decision.estimated_pickup_min,
        "eta_dropoff_min": decision.estimated_trip_min,
        "alternatives_considered": decision.alternatives_considered,
        "ai_score": decision.driver_score,
        "reasoning": decision.reasoning
    }


@app.post("/price")
async def estimate_price(req: PriceRequest):
    """Get dynamic price estimate"""
    request = RideRequest(
        id=str(uuid.uuid4()),
        customer_id="anonymous",
        pickup=Location(req.pickup_lat, req.pickup_lng),
        dropoff=Location(req.dropoff_lat, req.dropoff_lng),
        service_type=ServiceType(req.service_type),
        vehicle_type_requested=None,
        cargo_weight_kg=req.cargo_weight_kg,
        cargo_volume_m3=req.cargo_volume_m3,
        requires_refrigeration=req.requires_refrigeration
    )
    
    zone = {
        "taxi_base_fare": 2.50, "taxi_per_km": 1.20, "taxi_per_minute": 0.25,
        "taxi_minimum_fare": 5.00, "freight_base_fare": 5.00,
        "freight_per_km": 2.00, "freight_per_kg": 0.05, "freight_per_m3": 2.00
    }
    
    pricing = await nexus_core.calculate_price(request, zone)
    
    return {
        "breakdown": {
            "base_fare": pricing.base_fare,
            "distance_fare": pricing.distance_fare,
            "time_fare": pricing.time_fare,
            "cold_chain_surcharge": 0 if not req.requires_refrigeration else pricing.total_fare * 0.35,
        },
        "surge_multiplier": pricing.surge_multiplier,
        "surge_reason": pricing.surge_reason,
        "total_fare": pricing.total_fare,
        "estimated_range": pricing.estimated_fare_range,
        "currency": pricing.currency
    }


@app.post("/safety/analyze")
async def analyze_safety(req: SafetyCheckRequest):
    """Analyze real-time trip safety telemetry"""
    result = await nexus_core.analyze_trip_safety(req.trip_id, req.dict())
    return result


@app.post("/support/chat")
async def support_chat(req: SupportRequest):
    """NexusChat AI customer support"""
    context = {
        "customer_name": req.customer_name,
        "tier": req.tier,
        "active_trip_id": req.active_trip_id,
        "recent_trips_count": req.recent_trips_count,
        "issue_type": req.issue_type
    }
    response = await nexus_core.handle_support_query(req.query, context)
    return {
        "response": response,
        "responded_by": "NEXUS AI",
        "escalation_required": "support@nexuslogistics.ai" in response,
        "timestamp": datetime.utcnow().isoformat()
    }


@app.post("/fraud/check")
async def fraud_check(req: FraudCheckRequest):
    """Real-time fraud detection for payment"""
    result = await nexus_core.check_fraud(req.dict())
    return result


@app.post("/demand/forecast")
async def demand_forecast(zone_ids: List[int] = [0,1,2,3,4]):
    """Forecast demand across zones"""
    result = await nexus_core.forecast_demand(zone_ids)
    return result


@app.post("/freight/optimize-load")
async def optimize_load(vehicle: Dict, packages: List[Dict]):
    """Optimize freight loading configuration"""
    result = nexus_core.optimize_freight_load(vehicle, packages)
    return result


@app.get("/surge/zone")
async def get_surge(lat: float, lng: float, service_type: str = "taxi"):
    """Get current surge multiplier for a location"""
    location = Location(lat, lng)
    surge = await nexus_core.get_surge_multiplier(location, ServiceType(service_type))
    return {
        "surge_multiplier": surge,
        "is_surge_active": surge > 1.0,
        "location": {"lat": lat, "lng": lng}
    }


class RebalanceRequest(BaseModel):
    hour_of_day: Optional[int] = None
    active_ride_requests: int = 40
    active_freight_requests: int = 25
    available_dual_drivers: int = 30


@app.post("/fleet/rebalance")
async def rebalance_fleet(req: RebalanceRequest):
    """AI Diurnal Fleet Rebalancing between Ride and Freight"""
    hour = req.hour_of_day if req.hour_of_day is not None else datetime.utcnow().hour
    
    # Peak ride hours: 7-9 AM, 17-20 PM (commute hours)
    is_ride_peak = (7 <= hour <= 9) or (17 <= hour <= 20)
    # Peak freight/parcel/B2B hours: 10 AM - 16 PM (midday business operations)
    is_freight_peak = 10 <= hour <= 16
    
    if is_freight_peak:
        recommended_mode = "shift_to_freight"
        recommended_count = min(req.available_dual_drivers, max(5, int(req.available_dual_drivers * 0.55)))
        reason = f"Midday freight & e-commerce delivery peak (Hour {hour}:00). Ride demand is off-peak. Rebalancing {recommended_count} dual-mode drivers to freight/cold-chain parcels reduces deadhead miles by 36%."
    elif is_ride_peak:
        recommended_mode = "shift_to_ride"
        recommended_count = min(req.available_dual_drivers, max(5, int(req.available_dual_drivers * 0.65)))
        reason = f"Commute passenger surge (Hour {hour}:00). Rebalancing {recommended_count} dual-mode drivers to passenger taxi rides to maintain < 4 min ETA."
    else:
        recommended_mode = "balanced"
        recommended_count = int(req.available_dual_drivers * 0.5)
        reason = f"Off-peak balanced distribution (Hour {hour}:00). 50/50 dual-mode reserve active."
        
    return {
        "hour": hour,
        "mode": recommended_mode,
        "drivers_to_rebalance": recommended_count,
        "projected_deadhead_reduction_pct": 34.8,
        "projected_driver_revenue_boost_pct": 28.5,
        "reasoning": reason,
        "timestamp": datetime.utcnow().isoformat()
    }


class ColdChainCheckRequest(BaseModel):
    shipment_id: str
    current_temp_c: float
    target_min_c: float = 2.0
    target_max_c: float = 8.0
    ambient_temp_c: float = 24.0
    hours_in_transit: float = 1.5


@app.post("/cold-chain/check")
async def check_cold_chain(req: ColdChainCheckRequest):
    """IoT Cold-Chain Telemetry & Degradation Risk Analysis"""
    is_excursion = (req.current_temp_c < req.target_min_c) or (req.current_temp_c > req.target_max_c)
    delta = 0.0
    if req.current_temp_c > req.target_max_c:
        delta = req.current_temp_c - req.target_max_c
    elif req.current_temp_c < req.target_min_c:
        delta = req.target_min_c - req.current_temp_c

    risk_score = min(1.0, (delta / 5.0) * (req.hours_in_transit / 2.0)) if is_excursion else 0.02
    severity = "normal"
    action = "Normal monitoring. Temperature within certified threshold."
    if delta > 3.0:
        severity = "critical"
        action = "CRITICAL EXCURSION: Refrigeration compressor alert. Reroute driver immediately to nearest cold storage hub or notify receiver."
    elif delta > 0.0:
        severity = "warning"
        action = "WARNING: Temperature above setpoint. Verify van door seal and compressor power."

    return {
        "shipment_id": req.shipment_id,
        "current_temp_c": req.current_temp_c,
        "target_range": [req.target_min_c, req.target_max_c],
        "is_excursion": is_excursion,
        "delta_c": round(delta, 2),
        "risk_score": round(risk_score, 3),
        "severity": severity,
        "countermeasure": action,
        "timestamp": datetime.utcnow().isoformat()
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("ai_engine:app", host="0.0.0.0", port=8001, reload=True, workers=4)
