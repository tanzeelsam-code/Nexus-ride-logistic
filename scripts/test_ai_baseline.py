import asyncio
import unittest
from ai_engine import NexoraCore, Driver, Location, RideRequest, ServiceType, health

class BaselineTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_untrained_models_are_constructed(self):
        core = NexoraCore()
        self.assertFalse(hasattr(core, 'dispatch_model'))
        result = await health()
        self.assertTrue(all(value == 'disabled_untrained' for value in result['models'].values()))

    async def test_dispatch_is_repeatable_and_prefers_nearby_eligible_driver(self):
        core = NexoraCore()
        request = RideRequest('r','u',Location(40.7,-74),Location(40.8,-74),ServiceType.TAXI,None)
        def driver(id,lat,services):
            return Driver(id=id,lat=lat,lng=-74,rating=4.8,acceptance_rate=95,completion_rate=98,vehicle_type='sedan',service_types=services,total_trips=10)
        drivers = [driver('far',40.72,['taxi']),driver('near',40.701,['taxi']),driver('ineligible',40.7001,['freight'])]
        decisions = [await core.dispatch(request,drivers) for _ in range(3)]
        self.assertEqual([d.assigned_driver_id for d in decisions],['near']*3)
        self.assertEqual(len(set(d.driver_score for d in decisions)),1)
        self.assertTrue(all(d.confidence == 0 for d in decisions))

    async def test_missing_history_does_not_produce_forecasts(self):
        result = await NexoraCore().forecast_demand([1,2])
        self.assertFalse(result['available'])
        self.assertEqual(result['horizons'],{})
        self.assertEqual(result['recommended_positioning'],[])

if __name__ == '__main__':
    unittest.main()
