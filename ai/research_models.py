"""Untrained research architectures. Never imported by the serving runtime."""
import torch
import torch.nn as nn
import torch.nn.functional as F

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

        # Time features are per-request; broadcast them across the zone sequence.
        t_emb = t_emb.unsqueeze(1).expand(-1, z_emb.size(1), -1)

        x = torch.cat([z_emb, t_emb, f_emb], dim=-1)
        x = self.input_proj(x)
        x = self.transformer(x)

        forecasts = [head(x[:, -1, :]) for head in self.forecast_heads]
        return torch.stack(forecasts, dim=1)  # [B, 5_horizons, n_zones]
