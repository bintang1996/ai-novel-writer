import brandMark from '../../../assets/brand/app-mark.png'
import { APP_BRAND } from '../../../shared/brand'
import { useLocaleStore } from '../../../stores/locale-store'

/** 关于：应用名、版本与定位说明。 */
export default function AboutSection() {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="stage-set-rows">
      <div className="stage-set-about">
        <img className="stage-set-about-mark" src={brandMark} alt="" aria-hidden="true" />
        <div>
          <p className="stage-set-about-name">{text(`${APP_BRAND.zhName} ${APP_BRAND.enName}`, APP_BRAND.enName)}</p>
          <p className="stage-set-about-version">{text('版本', 'Version')} <span className="pi-num">{__APP_VERSION__}</span></p>
        </div>
      </div>
      <p className="stage-set-about-text">{text(
        '面向长篇小说的本地写作工具。作品、设定与草稿都存在你的电脑上；从设定、架构、蓝图到正文，每一步都可以交给你选择的模型协助。',
        'A local writing tool for long-form fiction. Your books, settings and drafts stay on your computer, and every step from setup to manuscript can be assisted by the models you choose.',
      )}</p>
    </div>
  )
}
