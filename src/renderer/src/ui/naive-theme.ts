import type { GlobalThemeOverrides } from 'naive-ui'

const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"

const componentOverrides: GlobalThemeOverrides = {
  Button: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadiusSmall: '8px',
    borderRadiusMedium: '9px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Input: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadius: '9px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px',
    paddingSmall: '0 10px',
    paddingMedium: '0 10px'
  },
  Radio: {
    buttonHeightSmall: '30px',
    buttonHeightMedium: '32px',
    buttonBorderRadius: '9px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Select: {
    menuBoxShadow: '0 2px 8px rgba(24, 50, 37, 0.08), 0 18px 46px rgba(24, 50, 37, 0.14)'
  },
  Switch: {
    railHeightMedium: '20px',
    railWidthMedium: '38px',
    buttonHeightMedium: '16px',
    buttonWidthMedium: '16px'
  }
}

export const teahouseLightThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#3d8b6b',
    primaryColorHover: '#4c9b7b',
    primaryColorPressed: '#34785d',
    primaryColorSuppl: '#3d8b6b',
    infoColor: '#3d8b6b',
    infoColorHover: '#4c9b7b',
    infoColorPressed: '#34785d',
    infoColorSuppl: '#3d8b6b',
    textColorBase: '#17211c',
    textColor1: '#17211c',
    textColor2: '#58645e',
    textColor3: '#87918c',
    placeholderColor: '#a9b2ad',
    borderColor: 'rgba(40, 66, 53, 0.14)',
    dividerColor: 'rgba(40, 66, 53, 0.1)',
    bodyColor: '#f9fbfa',
    cardColor: '#ffffff',
    modalColor: '#f9fbfa',
    popoverColor: '#ffffff',
    inputColor: 'rgba(255, 255, 255, 0.86)',
    hoverColor: 'rgba(38, 61, 50, 0.055)',
    pressedColor: 'rgba(61, 139, 107, 0.14)',
    fontFamily,
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontSize: '13px',
    heightSmall: '30px',
    heightMedium: '34px'
  }
}

export const teahouseDarkThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#5bbf91',
    primaryColorHover: '#70cda1',
    primaryColorPressed: '#49aa7e',
    primaryColorSuppl: '#5bbf91',
    infoColor: '#5bbf91',
    infoColorHover: '#70cda1',
    infoColorPressed: '#49aa7e',
    infoColorSuppl: '#5bbf91',
    textColorBase: '#edf2ef',
    textColor1: '#edf2ef',
    textColor2: '#b7c0bb',
    textColor3: '#7f8c85',
    placeholderColor: '#66716b',
    borderColor: 'rgba(222, 238, 229, 0.14)',
    dividerColor: 'rgba(222, 238, 229, 0.09)',
    bodyColor: '#171b19',
    cardColor: '#222a25',
    modalColor: '#171b19',
    popoverColor: '#222a25',
    inputColor: '#222a25',
    hoverColor: 'rgba(235, 245, 239, 0.06)',
    pressedColor: 'rgba(91, 191, 145, 0.2)',
    fontFamily,
    borderRadius: '10px',
    borderRadiusSmall: '8px',
    fontSize: '13px',
    heightSmall: '30px',
    heightMedium: '34px'
  }
}
