here's what worked locally.


training:

python beets2tsnot.py --tsnot-config tsnotfyi-config.json --path /__no_tracks__ \
--train-vae --vae-epochs 200 --vae-batch-size 128 --vae-beta 0.05 --vae-beta-start 0.001 --vae-beta-warmup 100


scope calibration:

./scripts/calibrate_embeddings.py --mode vae  --sample-centers 400 --neighbor-count 250


verify coverge:

python scripts/analyze_dimension_utility.py --sample-tracks 200\n

