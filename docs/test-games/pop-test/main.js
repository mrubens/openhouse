import * as Phaser from 'phaser';
let score = 0;
new Phaser.Game({
  type: Phaser.AUTO, width: 1920, height: 1080, backgroundColor: '#264653',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  physics: { default: 'arcade', arcade: { gravity: { x: 0, y: -60 } } },
  scene: {
    create() {
      console.log('renderer', this.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas');
      const label = this.add.text(960, 80, 'Pop: 0', { fontSize: '64px', color: '#fff' }).setOrigin(0.5);
      this.time.addEvent({ delay: 500, loop: true, callback: () => {
        const c = Phaser.Display.Color.HSVToRGB(Math.random(), 0.6, 1).color;
        const b = this.add.circle(200 + Math.random() * 1520, 1150, 60, c).setInteractive();
        this.physics.add.existing(b);
        b.on('pointerdown', () => { score++; label.setText('Pop: ' + score); b.destroy(); });
      } });
    },
  },
});
